// Eval runner: npm run eval -- [--task id] [--runs N] [--concurrency N] [--skills off|available|preloaded|routed] [--without-mcp] [--without-skill-tasks] [--keep] [--verbose]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ANSWER_MERGE_SEPARATOR, runAgent } from "../src/agent.js";
import { loadEnv } from "../src/config.js";
import { missingEnv } from "../src/llm/index.js";
import { installShutdownHandlers, registerCleanup } from "../src/process.js";
import { tasks } from "./tasks/index.js";
import { classifyOutcome, evalSettings } from "./options.js";
import { maxRequestTokens } from "./helpers.js";
import type { CheckResult, EvalTask, WebContext } from "./types.js";
import { CHROME_DEVTOOLS_MCP, prewarmChromeDevtools, serveSite, type SiteServer } from "./web.js";

interface RunRecord {
  taskId: string;
  run: number;
  pass: boolean;
  /** "error": the run ended on an API/infrastructure error (after retries); excluded from pass rates. */
  outcome: "pass" | "fail" | "error";
  reason?: string;
  stopReason: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  compactions: number;
  level2Accepted: number;
  level2Rejected: number;
  repeatedCalls: number;
  missingFileReads: number;
  descriptionRejected: number;
  /** Total harness nudges (note-taking + missing-file + repeat + coverage). */
  nudges: number;
  /** Input tokens spent on compaction calls (Level 1 descriptions + Level 2 summaries). */
  compactionInputTokens?: number;
  compactionOutputTokens?: number;
  mainInputTokens?: number;
  mainOutputTokens?: number;
  tokenRatio?: number;
  answerMerged?: boolean;
  /** Listed files never read, at the end of the run. */
  unreadAtEnd?: number;
  logFile?: string;
  sandbox?: string;
  /** Tool calls the model emitted, by tool name. */
  toolCalls?: Record<string, number>;
  mcpCalls?: number;
  /** Side-effecting calls after MCP content: the guard asked (and the runner denied). */
  guardFired?: number;
  /** Largest actual input token count of any main request (from the API usage). */
  maxRequestTokens?: number;
  /** Task-specific observations from the check. */
  details?: Record<string, unknown>;
  /** Skills condition of the run: "off" or "available" (listed, nothing preloaded). */
  skillsCondition?: string;
  skillsLoaded?: string[];
  /** "available" runs of tasks with an expected skill: did the model load it? */
  trigger?: "correct" | "none" | "wrong";
  /** "routed" runs: the router's choice and reason. */
  routedSkill?: string | null;
  routerReason?: string;
}

interface TaskSummary {
  taskId: string;
  runs: number;
  passes: number;
  /** Runs that ended on API/infrastructure errors (not counted in the pass rate). */
  errors?: number;
  avgSteps: number;
  avgTokens: number;
  avgSeconds: number;
  avgCompactions: number;
  avgRepeatedCalls: number;
  level2Accepted: number;
  level2Rejected: number;
  missingFileReads: number;
  descriptionRejected: number;
  nudges: number;
  failures: string[];
}

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(EVALS_DIR, "results");

const USAGE =
  "Usage: npm run eval -- [--task id] [--runs N] [--concurrency N] [--skills off|available|preloaded|routed] " +
  "[--without-mcp] [--without-skill-tasks] [--compact-model M] [--results-dir DIR] [--keep] [--verbose]\n" +
  'Put -- after "npm run eval" so npm passes the options on, e.g. npm run eval -- --runs 3';

function parseRunnerArgs() {
  try {
    return parseArgs({
      options: {
        task: { type: "string" },
        runs: { type: "string", default: "1" },
        concurrency: { type: "string", default: "1" },
        keep: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        "compact-model": { type: "string" },
        /** Skip tasks that need an MCP server (e.g. to check the core suite alone). */
        "without-mcp": { type: "boolean", default: false },
        /** Skip the with/without-skills tasks (those with an expected skill). */
        "without-skill-tasks": { type: "boolean", default: false },
        /** "off" (default), "available" (listed, none preloaded), "preloaded" (the task's skill up front) or "routed" (the skill router picks). */
        skills: { type: "string", default: "off" },
        /** Where results (and logs/) go; default evals/results. */
        "results-dir": { type: "string" },
      },
    });
  } catch (err) {
    // npm swallows options given without "--" (npm run eval --runs 1 passes a bare "1").
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(1);
  }
}
const { values: args } = parseRunnerArgs();

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Error: --${name} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

loadEnv();
const missing = missingEnv();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}

const runs = positiveInt("runs", args.runs!);
const concurrency = positiveInt("concurrency", args.concurrency!);
if (!["off", "available", "preloaded", "routed"].includes(args.skills!)) {
  console.error(`Error: --skills must be off, available, preloaded or routed, got "${args.skills}"`);
  process.exit(1);
}
const skillsCondition = args.skills as "off" | "available" | "preloaded" | "routed";
const selected = (args.task ? tasks.filter((t) => t.id === args.task) : tasks).filter((t) => !(args["without-mcp"] && t.mcpServers))
  .filter((t) => !(args["without-skill-tasks"] && t.expectedSkill));
if (selected.length === 0) {
  console.error(`Error: unknown task "${args.task}". Available: ${tasks.map((t) => t.id).join(", ")}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultsDir = args["results-dir"] ? path.resolve(args["results-dir"]) : RESULTS_DIR;
const logsRoot = path.join(resultsDir, "logs", timestamp);
const records: RunRecord[] = [];
/** Sandboxes of running jobs, removed on Ctrl+C (unless --keep). */
const activeSandboxes = new Set<string>();
/** Set on Ctrl+C: no new jobs start. */
let interrupted = false;

async function runJob(task: EvalTask, run: number): Promise<RunRecord> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-eval-"));
  activeSandboxes.add(base);
  const dir = path.join(base, "work");
  fs.mkdirSync(dir);
  let site: SiteServer | undefined;
  const record: RunRecord = {
    taskId: task.id,
    run,
    pass: false,
    outcome: "fail",
    stopReason: "error",
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    compactions: 0,
    level2Accepted: 0,
    level2Rejected: 0,
    repeatedCalls: 0,
    missingFileReads: 0,
    descriptionRejected: 0,
    nudges: 0,
    ...(args.keep && { sandbox: dir }),
  };
  try {
    try {
      await task.setup?.(dir);
    } catch (err) {
      record.reason = `setup failed: ${errorMessage(err)}`;
      return record;
    }

    let web: WebContext | undefined;
    if (task.site) {
      const siteDir = path.join(base, "site");
      fs.mkdirSync(siteDir);
      await task.site(siteDir);
      site = await serveSite(siteDir);
      web = { baseUrl: site.baseUrl, requests: site.requests };
    }
    const prompt = typeof task.prompt === "function" ? task.prompt({ baseUrl: web?.baseUrl ?? "" }) : task.prompt;

    if (args.verbose) console.log(`\n===== ${task.id} #${run} =====`);
    const result = await runAgent({
      task: prompt,
      cwd: dir,
      autoApprove: true,
      quiet: !args.verbose,
      logDir: path.join(logsRoot, `${task.id}-${run}`),
      // Every setting explicit: ~/.harness/.env and env vars can't change eval behavior (A8).
      ...evalSettings(task, { mainModel: process.env.OPENAI_MODEL, compactModel: args["compact-model"], skills: skillsCondition }),
      // Nobody can answer: the untrusted-content guard is recorded (result.untrustedGuard) and denied.
      confirmUntrusted: async () => false,
    });
    Object.assign(record, {
      stopReason: result.stopReason,
      steps: result.steps,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: result.durationMs,
      compactions: result.compactions,
      level2Accepted: result.compactionStats.level2Accepted,
      level2Rejected: result.compactionStats.level2Rejected,
      repeatedCalls: result.repeatedCalls,
      missingFileReads: result.missingFileReads,
      descriptionRejected: result.compactionStats.descriptionRejected,
      nudges: result.nudges.notes + result.nudges.missingFile + result.nudges.repeat + result.nudges.coverage,
      compactionInputTokens: result.compactionUsage.inputTokens,
      compactionOutputTokens: result.compactionUsage.outputTokens,
      mainInputTokens: result.mainUsage.inputTokens,
      mainOutputTokens: result.mainUsage.outputTokens,
      tokenRatio: result.tokenRatio,
      answerMerged: result.answerHistory.length > 1 && result.finalText?.includes(ANSWER_MERGE_SEPARATOR.trim()),
      unreadAtEnd: result.coverage.unread.length,
      logFile: path.relative(process.cwd(), result.logFile),
      toolCalls: result.toolCalls,
      mcpCalls: result.mcp.calls,
      guardFired: result.untrustedGuard.length,
      maxRequestTokens: maxRequestTokens(result.logFile),
      skillsCondition,
      skillsLoaded: result.skillsLoaded,
      ...(result.skillRouting && { routedSkill: result.skillRouting.skill, routerReason: result.skillRouting.reason }),
      ...((skillsCondition === "available" || skillsCondition === "routed") &&
        task.expectedSkill && {
          trigger: result.skillsLoaded.length === 0 ? "none" : result.skillsLoaded.includes(task.expectedSkill) ? "correct" : "wrong",
        }),
    });

    let check: CheckResult;
    if (result.stopReason === "error") {
      check = { pass: false, reason: `agent error: ${result.error}` };
    } else {
      try {
        check = await task.check(dir, result, { ...(web && { web }) });
      } catch (err) {
        check = { pass: false, reason: `check threw: ${errorMessage(err)}` };
      }
      if (!check.pass && result.stopReason === "max_steps") check.reason = `hit max steps; ${check.reason ?? ""}`;
    }
    record.pass = check.pass;
    record.outcome = classifyOutcome(check.pass, result.errorKind);
    if (check.reason) record.reason = check.reason;
    if (check.details) record.details = check.details;
    return record;
  } finally {
    await site?.close();
    if (!args.keep) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    activeSandboxes.delete(base);
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
      errors: rs.filter((r) => r.outcome === "error").length,
      avgSteps: avg((r) => r.steps),
      avgTokens: avg((r) => r.inputTokens + r.outputTokens),
      avgSeconds: avg((r) => r.durationMs) / 1000,
      avgCompactions: avg((r) => r.compactions),
      avgRepeatedCalls: avg((r) => r.repeatedCalls),
      level2Accepted: rs.reduce((n, r) => n + r.level2Accepted, 0),
      level2Rejected: rs.reduce((n, r) => n + r.level2Rejected, 0),
      missingFileReads: rs.reduce((n, r) => n + r.missingFileReads, 0),
      descriptionRejected: rs.reduce((n, r) => n + r.descriptionRejected, 0),
      nudges: rs.reduce((n, r) => n + r.nudges, 0),
      failures: [...new Set(rs.filter((r) => !r.pass).map((r) => r.reason ?? "unknown"))],
    };
  });
}

function printTable(summaries: TaskSummary[]): void {
  const header = ["task", "pass", "err", "steps", "tokens", "secs", "compact", "L2 a/r", "repeats", "missing", "desc rej", "nudges", "failure reasons"];
  const rows = summaries.map((s) => [
    s.taskId,
    `${s.passes}/${s.runs - (s.errors ?? 0)}`,
    String(s.errors ?? 0),
    s.avgSteps.toFixed(1),
    Math.round(s.avgTokens).toLocaleString("en-US"),
    s.avgSeconds.toFixed(1),
    s.avgCompactions.toFixed(1),
    `${s.level2Accepted}/${s.level2Rejected}`,
    s.avgRepeatedCalls.toFixed(1),
    String(s.missingFileReads),
    String(s.descriptionRejected),
    String(s.nudges),
    s.failures.map((f) => (f.length > 70 ? f.slice(0, 70) + "…" : f)).join(" | "),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmtRow = (r: string[]) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ");
  console.log("\n" + fmtRow(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmtRow(r));

  const passes = summaries.reduce((s, x) => s + x.passes, 0);
  const errors = summaries.reduce((s, x) => s + (x.errors ?? 0), 0);
  const total = summaries.reduce((s, x) => s + x.runs, 0);
  console.log(
    `\nTotal: ${passes}/${total - errors} passed` +
      (errors ? ` (${errors} run${errors === 1 ? "" : "s"} ended on API/infrastructure errors; excluded from pass rates)` : ""),
  );
}

function compareWithPrevious(summaries: TaskSummary[]): void {
  const previous = fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort().at(-1)
    : undefined;
  if (!previous) {
    console.log("\nNo previous results to compare with.");
    return;
  }
  let prevSummaries: TaskSummary[];
  try {
    prevSummaries = JSON.parse(fs.readFileSync(path.join(resultsDir, previous), "utf8")).summary;
  } catch (err) {
    console.log(`\nCould not read previous results ${previous}: ${errorMessage(err)}`);
    return;
  }
  const changes: string[] = [];
  for (const s of summaries) {
    const p = prevSummaries.find((x) => x.taskId === s.taskId);
    // Pass rates exclude runs that ended on API/infrastructure errors.
    const scored = (x: TaskSummary) => x.runs - (x.errors ?? 0);
    if (!p || scored(p) === 0 || scored(s) === 0) continue;
    const before = p.passes / scored(p);
    const after = s.passes / scored(s);
    if (before === after) continue;
    const label = after > before ? "\x1b[32mimproved\x1b[0m" : "\x1b[31mregressed\x1b[0m";
    changes.push(`  ${s.taskId}: ${p.passes}/${scored(p)} → ${s.passes}/${scored(s)} (${label})`);
  }
  console.log(changes.length ? `\nChanges vs ${previous}:\n${changes.join("\n")}` : `\nNo pass/fail changes vs ${previous}.`);
}

/** Write the results file atomically (temp file + rename), so it is never left half-written. */
function writeResults(records: RunRecord[], extra: Record<string, unknown> = {}): string {
  const order = new Map(selected.map((t, i) => [t.id, i]));
  const sorted = [...records].sort((a, b) => order.get(a.taskId)! - order.get(b.taskId)! || a.run - b.run);
  fs.mkdirSync(resultsDir, { recursive: true });
  const outFile = path.join(resultsDir, `${timestamp}.json`);
  const data = { timestamp, model: process.env.OPENAI_MODEL, options: { ...args, runs, concurrency }, ...extra, summary: summarize(sorted), results: sorted };
  fs.writeFileSync(`${outFile}.tmp`, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(`${outFile}.tmp`, outFile);
  return outFile;
}

// Ctrl+C: shut down MCP server process trees (browsers), then save the completed runs and
// remove the sandboxes of the interrupted ones.
installShutdownHandlers();
registerCleanup(() => {
  interrupted = true;
  const outFile = writeResults(records, { interrupted: true });
  console.log(`\nInterrupted: ${records.length} completed run(s) saved to ${path.relative(process.cwd(), outFile)}`);
  if (!args.keep) for (const dir of activeSandboxes) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
if (selected.some((t) => t.mcpServers)) {
  console.log(`Pre-warming ${CHROME_DEVTOOLS_MCP} in the npx cache…`);
  prewarmChromeDevtools();
}

// Run all jobs through a simple worker pool.
const jobs = selected.flatMap((task) => Array.from({ length: runs }, (_, i) => ({ task, run: i + 1 })));
console.log(
  `Running ${jobs.length} job(s): ${selected.length} task(s) × ${runs} run(s), concurrency ${concurrency}, skills ${skillsCondition}, model ${process.env.OPENAI_MODEL}`,
);

await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (let job = jobs.shift(); job && !interrupted; job = jobs.shift()) {
      const r = await runJob(job.task, job.run);
      records.push(r);
      const mark = r.pass ? "\x1b[32m✓\x1b[0m" : r.outcome === "error" ? "\x1b[33m!\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(
        `${mark} ${r.taskId} #${r.run}  ${r.steps} steps  ${(r.inputTokens + r.outputTokens).toLocaleString("en-US")} tokens  ` +
          `${(r.durationMs / 1000).toFixed(1)}s${r.compactions ? `  ${r.compactions} compaction(s)` : ""}` +
          `${r.repeatedCalls ? `  ${r.repeatedCalls} repeated call(s)` : ""}` +
          (r.skillsLoaded?.length ? `  skills: ${r.skillsLoaded.join(", ")}` : "") +
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

const outFile = writeResults(records);
console.log(`\nResults saved to ${path.relative(process.cwd(), outFile)}`);
if (args.keep) console.log("Sandboxes kept (see `sandbox` in the results file).");
