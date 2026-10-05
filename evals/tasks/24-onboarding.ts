import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";
import { scoreOnboarding } from "../scoring.js";

// A ~16-file service with an entry point, three layers (api / services / store), and one
// non-obvious flow: a scan is saved by the service, which emits an event; main.ts wired that
// event to the audit log, so the audit write is not reachable by following direct calls.
const FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "parcel-tracker", version: "1.4.0", type: "module", scripts: { start: "tsx src/main.ts", test: "node --test test/" } },
    null,
    2,
  ),
  "README.md": "# parcel-tracker\n\nInternal service for parcel scans.\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true } }, null, 2),
  "src/main.ts": `import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { ParcelRepo } from "./store/parcelRepo.js";
import { AuditLog } from "./store/auditLog.js";
import { ScanService } from "./services/scanService.js";
import { TrackingService } from "./services/trackingService.js";
import { startServer } from "./api/server.js";

const config = loadConfig();
const bus = new EventBus();
const parcels = new ParcelRepo(config.dataDir);
const audit = new AuditLog(config.auditFile);

// Every recorded scan is written to the audit trail.
bus.on("parcel.scanned", (event) => audit.record(event));

const scans = new ScanService(parcels, bus);
const tracking = new TrackingService(parcels);
startServer({ port: config.port, scans, tracking });
`,
  "src/config.ts": `export interface Config { port: number; dataDir: string; auditFile: string }
export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    dataDir: process.env.DATA_DIR ?? "./data",
    auditFile: process.env.AUDIT_FILE ?? "./data/audit.log",
  };
}
`,
  "src/events/bus.ts": `type Listener = (event: Record<string, unknown>) => void;
/** Minimal publish/subscribe registry: listeners are registered by event name. */
export class EventBus {
  private listeners = new Map<string, Listener[]>();
  on(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: Record<string, unknown>): void {
    for (const l of this.listeners.get(name) ?? []) l(event);
  }
}
`,
  "src/api/server.ts": `import http from "node:http";
import { routes } from "./routes.js";
import type { ScanService } from "../services/scanService.js";
import type { TrackingService } from "../services/trackingService.js";

export interface Deps { port: number; scans: ScanService; tracking: TrackingService }

/** HTTP server: matches the request against the route table and calls the handler. */
export function startServer(deps: Deps): http.Server {
  const server = http.createServer(async (req, res) => {
    const route = routes.find((r) => r.method === req.method && r.path === new URL(req.url ?? "/", "http://x").pathname);
    if (!route) return void res.writeHead(404).end();
    const body = await readBody(req);
    const { status, json } = await route.handler(body, deps, req);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  });
  return server.listen(deps.port);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
  });
}
`,
  "src/api/routes.ts": `import { handleScan } from "./handlers/scan.js";
import { handleStatus } from "./handlers/status.js";
import { handleHealth } from "./handlers/health.js";

export const routes = [
  { method: "POST", path: "/scans", handler: handleScan },
  { method: "GET", path: "/status", handler: handleStatus },
  { method: "GET", path: "/health", handler: handleHealth },
];
`,
  "src/api/handlers/scan.ts": `import type { Deps } from "../server.js";

/** POST /scans — a depot scanner reports that it scanned a parcel. */
export async function handleScan(body: any, deps: Deps) {
  if (!body?.parcelId || !body?.depot) return { status: 400, json: { error: "parcelId and depot are required" } };
  const parcel = deps.scans.recordScan(body.parcelId, body.depot, body.scannedAt ?? new Date().toISOString());
  return { status: 201, json: parcel };
}
`,
  "src/api/handlers/status.ts": `import type { Deps } from "../server.js";
import type http from "node:http";

/** GET /status?parcelId=... — current status and ETA of a parcel. */
export async function handleStatus(_body: unknown, deps: Deps, req: http.IncomingMessage) {
  const id = new URL(req.url ?? "/", "http://x").searchParams.get("parcelId");
  if (!id) return { status: 400, json: { error: "parcelId is required" } };
  const status = deps.tracking.status(id);
  return status ? { status: 200, json: status } : { status: 404, json: { error: "unknown parcel" } };
}
`,
  "src/api/handlers/health.ts": `export async function handleHealth() {
  return { status: 200, json: { ok: true } };
}
`,
  "src/services/scanService.ts": `import type { ParcelRepo } from "../store/parcelRepo.js";
import type { EventBus } from "../events/bus.js";
import { newScanId } from "../util/ids.js";

/** Business rules for scans: validation, de-duplication, and the parcel's scan history. */
export class ScanService {
  constructor(private parcels: ParcelRepo, private bus: EventBus) {}

  recordScan(parcelId: string, depot: string, scannedAt: string) {
    const parcel = this.parcels.get(parcelId) ?? { id: parcelId, scans: [] as { id: string; depot: string; at: string }[] };
    const last = parcel.scans.at(-1);
    if (last && last.depot === depot) return parcel; // same depot twice: ignore
    const scan = { id: newScanId(), depot, at: scannedAt };
    parcel.scans.push(scan);
    this.parcels.save(parcel);
    this.bus.emit("parcel.scanned", { parcelId, ...scan });
    return parcel;
  }
}
`,
  "src/services/trackingService.ts": `import type { ParcelRepo } from "../store/parcelRepo.js";
import { estimateEta } from "./eta.js";

/** Read side: the current status of a parcel, derived from its scans. */
export class TrackingService {
  constructor(private parcels: ParcelRepo) {}
  status(parcelId: string) {
    const parcel = this.parcels.get(parcelId);
    if (!parcel) return null;
    const last = parcel.scans.at(-1);
    return { parcelId, lastDepot: last?.depot ?? null, scans: parcel.scans.length, eta: estimateEta(parcel.scans.length) };
  }
}
`,
  "src/services/eta.ts": `/** Rough ETA in days from the number of depots a parcel has passed (5 hops on average). */
export function estimateEta(hops: number): number {
  return Math.max(0, 5 - hops);
}
`,
  "src/store/parcelRepo.ts": `import fs from "node:fs";
import path from "node:path";

export interface Parcel { id: string; scans: { id: string; depot: string; at: string }[] }

/** Persistence for parcels: an in-memory map backed by one JSON file per parcel. */
export class ParcelRepo {
  private cache = new Map<string, Parcel>();
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  get(id: string): Parcel | undefined {
    if (!this.cache.has(id)) {
      const file = path.join(this.dir, id + ".json");
      if (fs.existsSync(file)) this.cache.set(id, JSON.parse(fs.readFileSync(file, "utf8")));
    }
    return this.cache.get(id);
  }
  save(parcel: Parcel): void {
    this.cache.set(parcel.id, parcel);
    fs.writeFileSync(path.join(this.dir, parcel.id + ".json"), JSON.stringify(parcel));
  }
}
`,
  "src/store/auditLog.ts": `import fs from "node:fs";

/** Append-only audit trail (one JSON line per event), kept for compliance. */
export class AuditLog {
  constructor(private file: string) {}
  record(event: Record<string, unknown>): void {
    fs.appendFileSync(this.file, JSON.stringify({ ...event, loggedAt: new Date().toISOString() }) + "\\n");
  }
}
`,
  "src/util/ids.ts": `import { randomUUID } from "node:crypto";
export const newScanId = () => "scan_" + randomUUID();
`,
  "test/scanService.test.ts": `import { test } from "node:test";
import assert from "node:assert/strict";
// ScanService ignores a repeated scan at the same depot.
test("duplicate depot scans are ignored", () => {
  assert.ok(true);
});
`,
};

export const task: EvalTask = {
  id: "onboarding",
  description: "Explain an unfamiliar ~16-file service: entry point, three layers, and an event-based data flow",
  prompt: "I just joined the team that owns this project. Explain how this codebase is structured and how it works.",
  expectedSkill: "codebase-onboarding",
  maxSteps: 30,
  setup(dir) {
    for (const [p, c] of Object.entries(FILES)) write(dir, p, c);
  },
  check(_dir, result) {
    // Pass: the outcome (entry point, layer roles, flow order) plus a coverage note.
    const score = scoreOnboarding(result.finalText);
    const missing = [...score.missingOutcome, ...(score.coverageNote ? [] : ["coverage note"])];
    const details = { ...score };
    return missing.length ? { ...fail(`missing: ${missing.join("; ")}`), details } : { ...pass(), details };
  },
};
