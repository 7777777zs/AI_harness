// Process-cleanup check with the real chrome-devtools-mcp server (no API calls: the model is
// scripted). For each scenario, counts the MCP server / Chrome processes before and after a run.
//   npx tsx evals/cleanup-check.ts            run every scenario
//   npx tsx evals/cleanup-check.ts --child X  (internal) run scenario X in a child process
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";
import { installShutdownHandlers } from "../src/process.js";
import { chromeDevtoolsServer, serveSite } from "./web.js";

interface Proc {
  pid: number;
  name: string;
  cmd: string;
}

/** node/cmd processes of the MCP server and the Chrome processes it started (never the user's own Chrome). */
function serverProcesses(): Proc[] {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'chrome-devtools-mcp' -or " +
    "($_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--headless|--remote-debugging-pipe|puppeteer') } | " +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";
  const out =
    process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true })
      : execFileSync("sh", ["-c", "ps -eo pid=,comm=,args= | grep chrome-devtools-mcp | grep -v grep || true"], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [pid, name, ...cmd] = l.includes("\t") ? l.split("\t") : l.trim().split(/\s+/);
      return { pid: Number(pid), name: name!, cmd: cmd.join(" ") };
    })
    .filter((p) => p.pid !== process.pid && !p.cmd.includes("cleanup-check") && !p.cmd.includes("Get-CimInstance"));
}

const summary = (ps: Proc[]) => {
  const byName = new Map<string, number>();
  for (const p of ps) byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
  return ps.length ? [...byName].map(([n, c]) => `${c}× ${n}`).join(", ") : "none";
};

/** Scripted model: open the page, snapshot it, then do what the scenario needs. */
function scriptedClient(baseUrl: string, scenario: string): LLMClient {
  let n = 0;
  const usage = { inputTokens: 1, outputTokens: 1 };
  const call = (name: string, args: Record<string, unknown>): LLMResponse => ({
    text: null,
    toolCalls: [{ id: `c${n}`, name, args }],
    usage,
    raw: null,
  });
  let pageId = 1;
  return {
    async chat(messages) {
      n++;
      if (n === 1) return call("mcp__chrome-devtools__new_page", { url: `${baseUrl}/index.html` });
      if (n === 2) {
        // new_page returns the page list, e.g. "2: Cleanup (http://…/index.html) [selected]".
        const opened = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
        pageId = Number(/^(\d+): .*\[selected\]$/m.exec(opened)?.[1] ?? 1);
        if (scenario === "normal") console.log(`  new_page result: ${JSON.stringify(opened.slice(0, 300))}`);
        return call("mcp__chrome-devtools__take_snapshot", { pageId });
      }
      if (scenario === "normal" && n === 3) {
        const snap = [...messages].reverse().find((m) => m.role === "tool");
        console.log(`  snapshot: ${JSON.stringify(snap?.content.slice(0, 400))}`);
      }
      if (scenario === "error") throw new Error("scripted model failure");
      if (scenario === "timeout" && n === 3) {
        return call("mcp__chrome-devtools__wait_for", { pageId, text: ["never appears"], timeout: 30_000 });
      }
      if (scenario === "sigint") {
        console.log(`  running: ${summary(serverProcesses())}; emitting SIGINT`);
        process.emit("SIGINT");
        return new Promise(() => {}); // the handler exits the process
      }
      if (scenario === "hardkill") {
        console.log("READY");
        return new Promise(() => {}); // the parent kills this process
      }
      return { text: "done", toolCalls: [], usage, raw: null };
    },
  };
}

async function runScenario(scenario: string): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-cleanup-"));
  fs.writeFileSync(path.join(base, "index.html"), "<html><head><title>Cleanup</title></head><body><h1>Hello</h1><p>Cleanup check page.</p></body></html>");
  const site = await serveSite(base);
  const servers = chromeDevtoolsServer();
  if (scenario === "timeout") {
    servers["chrome-devtools"]!.callTimeoutMs = 2_000;
    servers["chrome-devtools"]!.includeTools = [...servers["chrome-devtools"]!.includeTools!];
  }
  try {
    const result = await runAgent({
      task: "check",
      cwd: base,
      client: scriptedClient(site.baseUrl, scenario),
      quiet: true,
      autoApprove: true,
      mcp: { servers },
    });
    const statuses = result.mcp.servers.map((s) => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`).join("; ");
    console.log(`  run ended: ${result.stopReason}${result.error ? ` (${result.error})` : ""}; ${statuses}`);
    if (scenario === "timeout") {
      const log = fs.readFileSync(result.logFile, "utf8");
      console.log(`  timed out as expected: ${log.includes("timed out after 2s")}`);
    }
  } finally {
    await site.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main(): Promise<void> {
  const childIdx = process.argv.indexOf("--child");
  if (childIdx !== -1) {
    installShutdownHandlers();
    await runScenario(process.argv[childIdx + 1]!);
    return;
  }
  const self = fileURLToPath(import.meta.url);
  const initial = serverProcesses();
  console.log(`Before: ${summary(initial)}`);
  let ok = true;
  for (const scenario of ["normal", "error", "timeout", "sigint", "hardkill"]) {
    console.log(`\n# ${scenario}`);
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", self, "--child", scenario], {
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      });
      child.stdout.on("data", (d: Buffer) => {
        const text = d.toString();
        process.stdout.write(text.replace(/^READY\r?\n/m, ""));
        if (text.includes("READY")) {
          console.log(`  running: ${summary(serverProcesses())}; killing the harness process abruptly`);
          // Only the harness process, not its tree: this is the crash case.
          if (process.platform === "win32") spawnSync("taskkill", ["/F", "/PID", String(child.pid)], { stdio: "ignore" });
          else child.kill("SIGKILL");
        }
      });
      child.on("exit", (code) => {
        console.log(`  harness exited with ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        resolve();
      });
    });
    let left = serverProcesses();
    for (let i = 0; i < 20 && left.length > initial.length; i++) {
      await new Promise((r) => setTimeout(r, 500));
      left = serverProcesses();
    }
    const leaked = left.filter((p) => !initial.some((q) => q.pid === p.pid));
    console.log(`  after: ${leaked.length ? `LEFT BEHIND ${summary(leaked)}` : "no MCP/Chrome processes left"}`);
    if (leaked.length) {
      ok = false;
      for (const p of leaked) console.log(`    ${p.pid} ${p.name} ${p.cmd.slice(0, 140)}`);
      // Clean up so the next scenario starts from zero.
      for (const p of leaked) spawnSync("taskkill", ["/F", "/PID", String(p.pid)], { stdio: "ignore" });
    }
  }
  console.log(ok ? "\nAll scenarios left no processes behind." : "\nSome scenarios left processes behind (see above).");
  process.exitCode = ok ? 0 : 1;
}

await main();
