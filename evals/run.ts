// Eval runner: npm run eval -- [--task id] [--runs N] [--concurrency N] [--keep] [--verbose]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runAgent } from "../src/agent.js";
import { missingEnv } from "../src/llm/index.js";
import { tasks } from "./tasks/index.js";
import type { CheckResult, EvalTask } from "./types.js";

interface RunRecord {
  taskId: string;
  run: number;
  pass: boolean;
  reason?: string;
  stopReason: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  compactions: number;
  logFile?: string;
  sandbox?: string;
}

interface TaskSummary {
  taskId: string;
  runs: number;
  passes: number;
  avgSteps: number;
  avgTokens: number;
  avgSeconds: number;
  avgCompactions: number;
  failures: string[];
}

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(EVALS_DIR, "results");

const { values: args } = parseArgs({
  options: {
    task: { type: "string" },
    runs: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Error: --${name} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}
const missing = missingEnv();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const runs = positiveInt("runs", args.runs!);
const concurrency = positiveInt("concurrency", args.concurrency!);
const selected = args.task ? tasks.filter((t) => t.id === args.task) : tasks;
if (selected.length === 0) {
  console.error(`Error: unknown task "${args.task}". Available: ${tasks.map((t) => t.id).join(", ")}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logsRoot = path.join(RESULTS_DIR, "logs", timestamp);

async function runJob(task: EvalTask, run: number): Promise<RunRecord> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-eval-"));
  const dir = path.join(base, "work");
  fs.mkdirSync(dir);
  const record: RunRecord = {
    taskId: task.id,
    run,
    pass: false,
    stopReason: "error",
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    compactions: 0,
    ...(args.keep && { sandbox: dir }),
  };
  try {
    try {
      await task.setup?.(dir);
    } catch (err) {
      record.reason = `setup failed: ${errorMessage(err)}`;
      return record;
    }

    if (args.verbose) console.log(`\n===== ${task.id} #${run} =====`);
    const result = await runAgent({
      task: task.prompt,
      cwd: dir,
      autoApprove: true,
      quiet: !args.verbose,
      logDir: path.join(logsRoot, `${task.id}-${run}`),
      ...(task.contextLimit !== undefined && { contextLimit: task.contextLimit }),
      ...(task.compactThreshold !== undefined && { compactThreshold: task.compactThreshold }),
      ...(task.maxSteps !== undefined && { maxSteps: task.maxSteps }),
    });
    Object.assign(record, {
      stopReason: result.stopReason,
      steps: result.steps,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: result.durationMs,
      compactions: result.compactions,
      logFile: path.relative(process.cwd(), result.logFile),
    });

    let check: CheckResult;
    if (result.stopReason === "error") {
      check = { pass: false, reason: `agent error: ${result.error}` };
    } else {
      try {
        check = await task.check(dir, result);
      } catch (err) {
        check = { pass: false, reason: `check threw: ${errorMessage(err)}` };
      }
      if (!check.pass && result.stopReason === "max_steps") check.reason = `hit max steps; ${check.reason ?? ""}`;
    }
    record.pass = check.pass;
    if (check.reason) record.reason = check.reason;
    return record;
  } finally {
    if (!args.keep) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(records: RunRecord[]): TaskSummary[] {
  return selected.map((task) => {
    const rs = records.filter((r) => r.taskId === task.id);
    const avg = (f: (r: RunRecord) => number) => (rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : 0);
    return {
      taskId: task.id,
      runs: rs.length,
      passes: rs.filter((r) => r.pass).length,
      avgSteps: avg((r) => r.steps),
      avgTokens: avg((r) => r.inputTokens + r.outputTokens),
      avgSeconds: avg((r) => r.durationMs) / 1000,
      avgCompactions: avg((r) => r.compactions),
      failures: [...new Set(rs.filter((r) => !r.pass).map((r) => r.reason ?? "unknown"))],
    };
  });
}

function printTable(summaries: TaskSummary[]): void {
  const header = ["task", "pass", "steps", "tokens", "secs", "compact", "failure reasons"];
  const rows = summaries.map((s) => [
    s.taskId,
    `${s.passes}/${s.runs}`,
    s.avgSteps.toFixed(1),
    Math.round(s.avgTokens).toLocaleString("en-US"),
    s.avgSeconds.toFixed(1),
    s.avgCompactions.toFixed(1),
    s.failures.map((f) => (f.length > 70 ? f.slice(0, 70) + "…" : f)).join(" | "),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmtRow = (r: string[]) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ");
  console.log("\n" + fmtRow(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmtRow(r));

  const passes = summaries.reduce((s, x) => s + x.passes, 0);
  const total = summaries.reduce((s, x) => s + x.runs, 0);
  console.log(`\nTotal: ${passes}/${total} passed`);
}

function compareWithPrevious(summaries: TaskSummary[]): void {
  const previous = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json")).sort().at(-1)
    : undefined;
  if (!previous) {
    console.log("\nNo previous results to compare with.");
    return;
  }
  let prevSummaries: TaskSummary[];
  try {
    prevSummaries = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, previous), "utf8")).summary;
  } catch (err) {
    console.log(`\nCould not read previous results ${previous}: ${errorMessage(err)}`);
    return;
  }
  const changes: string[] = [];
  for (const s of summaries) {
    const p = prevSummaries.find((x) => x.taskId === s.taskId);
    if (!p || p.runs === 0 || s.runs === 0) continue;
    const before = p.passes / p.runs;
    const after = s.passes / s.runs;
    if (before === after) continue;
    const label = after > before ? "\x1b[32mimproved\x1b[0m" : "\x1b[31mregressed\x1b[0m";
    changes.push(`  ${s.taskId}: ${p.passes}/${p.runs} → ${s.passes}/${s.runs} (${label})`);
  }
  console.log(changes.length ? `\nChanges vs ${previous}:\n${changes.join("\n")}` : `\nNo pass/fail changes vs ${previous}.`);
}

// Run all jobs through a simple worker pool.
const jobs = selected.flatMap((task) => Array.from({ length: runs }, (_, i) => ({ task, run: i + 1 })));
const records: RunRecord[] = [];
console.log(
  `Running ${jobs.length} job(s): ${selected.length} task(s) × ${runs} run(s), concurrency ${concurrency}, model ${process.env.OPENAI_MODEL}`,
);

await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const r = await runJob(job.task, job.run);
      records.push(r);
      const mark = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(
        `${mark} ${r.taskId} #${r.run}  ${r.steps} steps  ${(r.inputTokens + r.outputTokens).toLocaleString("en-US")} tokens  ` +
          `${(r.durationMs / 1000).toFixed(1)}s${r.compactions ? `  ${r.compactions} compaction(s)` : ""}` +
          (r.reason ? `  — ${r.reason}` : ""),
      );
    }
  }),
);

const order = new Map(selected.map((t, i) => [t.id, i]));
records.sort((a, b) => order.get(a.taskId)! - order.get(b.taskId)! || a.run - b.run);
const summary = summarize(records);
printTable(summary);
compareWithPrevious(summary);

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = path.join(RESULTS_DIR, `${timestamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    { timestamp, model: process.env.OPENAI_MODEL, options: { ...args, runs, concurrency }, summary, results: records },
    null,
    2,
  ) + "\n",
);
console.log(`\nResults saved to ${path.relative(process.cwd(), outFile)}`);
if (args.keep) console.log("Sandboxes kept (see `sandbox` in the results file).");
