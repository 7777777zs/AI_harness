// Phase 4, Part A: answer merge (A1), coverage footer (A2), result/turn/preflight caps (A3),
// run_start logging (A4), calibrated estimation (A5), separate compaction model (A6), process-tree
// cleanup (A7), validated configuration with sources (A8). Mocked LLM, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import {
  ANSWER_MERGE_SEPARATOR,
  mergeAnswers,
  runAgent,
  type AgentResult,
} from "../src/agent.js";
import { capResult, capTurn, shrinkNewest } from "../src/context/budget.js";
import { Coverage } from "../src/context/coverage.js";
import { ContextTracker, estimateText, estimateTokens, estimateToolDefs } from "../src/context/tokens.js";
import { ConfigError, envFileSources, harnessHome, loadEnv, resolveConfig } from "../src/config.js";
import { readFile } from "../src/tools/readFile.js";
import { runCommand } from "../src/tools/runShell.js";
import { evalSettings } from "../evals/options.js";
import { tasks } from "../evals/tasks/index.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-p4-"));
  created.push(dir);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}

const usage0 = { inputTokens: 0, outputTokens: 0 };
const reply = (text: string | null, toolCalls: LLMResponse["toolCalls"] = [], usage = usage0): LLMResponse => ({
  text,
  toolCalls,
  usage,
  raw: null,
});
const logOf = (r: AgentResult) => fs.readFileSync(r.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Scripted main client: `script(n, messages)` answers the n-th agent request. */
function scripted(script: (n: number, messages: Message[]) => LLMResponse) {
  const requests: Message[][] = [];
  const client: LLMClient = {
    async chat(messages, tools) {
      if (tools.length === 0) return reply("{}"); // compaction calls, if any
      requests.push(structuredClone(messages));
      return script(requests.length - 1, messages);
    },
  };
  return { client, requests };
}

// ---- A1: final answer must not lose earlier content ----

test("A1: mergeAnswers keeps the previous answer when the new one is under 60% of it", () => {
  assert.deepEqual(mergeAnswers(["only"]), { text: "only", merged: false });
  assert.deepEqual(mergeAnswers(["a".repeat(100), "b".repeat(60)]), { text: "b".repeat(60), merged: false });
  const r = mergeAnswers(["a".repeat(100), "b".repeat(59)]);
  assert.equal(r.merged, true);
  assert.equal(r.text, "a".repeat(100) + ANSWER_MERGE_SEPARATOR + "b".repeat(59));
});

const FILES = {
  "app/a.py": "def a():\n    pass\n",
  "app/b.py": "def b():\n    pass\n",
  "app/c.py": "def c():\n    pass\n",
  "tests/test_a.py": "def test_a():\n    pass\n",
};

test("A1: after the coverage check, a much shorter answer is merged with the previous one (answer_merged logged)", async () => {
  const dir = project(FILES);
  const long = "Per-file summaries: " + "app/a.py does a; app/b.py does b; app/c.py does c. ".repeat(10);
  const { client, requests } = scripted((n) => {
    if (n === 0) return reply(null, [{ id: "l", name: "list_dir", args: { path: "." } }]);
    if (n === 1) return reply(null, [{ id: "r", name: "read_file", args: { path: "app/a.py" } }]);
    if (n === 2) return reply(long);
    return reply("I did not read tests/test_a.py."); // the short reply after the coverage check
  });
  const result = await runAgent({ task: "Summarize each source file", cwd: dir, client, quiet: true });

  assert.equal(result.nudges.coverage, 1);
  const followUp = requests[3]!.find((m) => m.role === "user" && m.content?.startsWith("You have not read these files"))!;
  assert.match(followUp.content!, /Your next reply replaces your previous answer, so it must be complete — include everything from your previous answer plus any additions\.$/);
  assert.deepEqual(result.answerHistory, [long, "I did not read tests/test_a.py."]);
  assert.ok(result.finalText!.startsWith(long + ANSWER_MERGE_SEPARATOR + "I did not read tests/test_a.py."), "earlier content kept");
  assert.ok(logOf(result).some((l) => l.type === "answer_merged"));
});

// ---- A2: coverage footer ----

test("A2: the footer groups unread files by directory and marks partial reads", () => {
  const files: Record<string, string> = { "db/init.sql": "x", "evaluation/run.py": "x", "README.md": "x" };
  for (let i = 0; i < 8; i++) files[`tests/test_${i}.py`] = "x";
  for (let i = 0; i < 4; i++) files[`app/m${i}.py`] = "x";
  const dir = project(files);
  const cov = new Coverage(dir);
  cov.addListing("glob", { pattern: "**/*" }, Object.keys(files).join("\n"));
  for (let i = 0; i < 4; i++) cov.markRead(`app/m${i}.py`);
  cov.markRead("README.md", true);
  assert.equal(
    cov.footer(),
    "--- Coverage (reported by harness): read 5 of 15 known files (1 only partially). " +
      "Not read: db/init.sql, evaluation/run.py, tests/ (8 files). Partially read (line ranges only): README.md.",
  );
  for (const f of Object.keys(files)) cov.markRead(f);
  assert.equal(cov.footer(), null, "no footer when everything was read in full");
});

async function footerRun(opts: { coverageFooter?: boolean; env?: string }) {
  const dir = project(FILES);
  const { client } = scripted((n) => {
    if (n === 0) return reply(null, [{ id: "l", name: "list_dir", args: { path: "." } }]);
    return reply("Summary: coverage is sufficient.");
  });
  const prev = process.env.COVERAGE_FOOTER;
  if (opts.env !== undefined) process.env.COVERAGE_FOOTER = opts.env;
  try {
    return await runAgent({
      task: "Summarize each source file",
      cwd: dir,
      client,
      quiet: true,
      coverageCheck: false,
      ...(opts.coverageFooter !== undefined && { coverageFooter: opts.coverageFooter }),
    });
  } finally {
    if (prev === undefined) delete process.env.COVERAGE_FOOTER;
    else process.env.COVERAGE_FOOTER = prev;
  }
}

test("A2: the footer is appended regardless of what the model wrote; COVERAGE_FOOTER=off disables it", async () => {
  const on = await footerRun({});
  assert.equal(
    on.finalText,
    "Summary: coverage is sufficient.\n\n--- Coverage (reported by harness): read 0 of 4 known files. " +
      "Not read: app/ (3 files), tests/test_a.py.",
  );
  assert.equal((await footerRun({ coverageFooter: false })).finalText, "Summary: coverage is sufficient.");
  assert.equal((await footerRun({ env: "off" })).finalText, "Summary: coverage is sufficient.");
});

// ---- A3: caps ----

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} ` + "x".repeat(60)).join("\n") + "\n";
const tokensOf = (s: string) => estimateText(s);

test("A3: read_file results are cut at a line boundary with a continuation note", async () => {
  const text = numbered(100);
  const out = capResult("read_file", { path: "f.txt" }, text, 500, tokensOf);
  const kept = out.split("\n").slice(0, -1);
  const n = kept.length;
  assert.ok(n > 5 && n < 100);
  assert.equal(kept.join("\n"), text.split("\n").slice(0, n).join("\n"), "whole lines, unchanged");
  assert.equal(out.split("\n").at(-1), `[Truncated at line ${n} of 100. Use read_file with offset=${n + 1} and limit to read more.]`);
  assert.ok(tokensOf(out) <= 500);

  // Ranged read_file output: line numbers are the file's, and M comes from the range footer.
  const dir = project({ "f.txt": text });
  const ranged = await readFile.execute({ path: "f.txt", offset: 21, limit: 60 }, { cwd: dir, confirm: async () => true });
  const cut = capResult("read_file", { path: "f.txt", offset: 21, limit: 60 }, ranged, 400, tokensOf);
  const last = /^\s*(\d+)\t/.exec(cut.split("\n").at(-2)!)![1];
  assert.equal(cut.split("\n").at(-1), `[Truncated at line ${last} of 100. Use read_file with offset=${Number(last) + 1} and limit to read more.]`);
  assert.ok(Number(last) > 21 && Number(last) < 80);
});

test("A3: other tools use head/tail truncation; results within the cap are unchanged", () => {
  const out = capResult("run_shell", { command: "x" }, "y".repeat(20_000), 1_000, tokensOf);
  assert.match(out, /\[\.\.\. truncated: [\d,]+ chars/);
  assert.ok(tokensOf(out) <= 1_000);
  assert.equal(capResult("read_file", { path: "a" }, "short", 1_000, tokensOf), "short");
});

test("A3: the per-turn cap shrinks the largest results first until the turn fits", () => {
  const results = [
    { name: "read_file", args: { path: "big.txt" }, content: numbered(300) },
    { name: "read_file", args: { path: "mid.txt" }, content: numbered(60) },
    { name: "read_file", args: { path: "small.txt" }, content: numbered(5) },
  ];
  const before = results.map((r) => tokensOf(r.content));
  const out = capTurn(results, 3_000, tokensOf);
  const after = out.map(tokensOf);
  assert.ok(after.reduce((a, b) => a + b, 0) <= 3_000);
  assert.ok(after[0]! < before[0]!, "largest shrunk");
  assert.equal(out[2], results[2]!.content, "small result untouched");
});

test("A3: a turn of many parallel reads can't exceed the limit (turn_capped logged)", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`f${i}.txt`] = numbered(100); // ~1.9k tokens each, ~11k together
  const dir = project(files);
  const { client, requests } = scripted((n) => {
    if (n === 0) return reply(null, Object.keys(files).map((p, i) => ({ id: `r${i}`, name: "read_file", args: { path: p } })));
    return reply("done");
  });
  const result = await runAgent({ task: "read", cwd: dir, client, quiet: true, contextLimit: 8_000 });
  const toolTokens = requests[1]!.filter((m) => m.role === "tool").reduce((s, m) => s + tokensOf(m.content!), 0);
  assert.ok(toolTokens <= 4_000 * 1.05, `turn results ~${toolTokens} tokens (cap 4000)`);
  assert.ok(estimateTokens(requests[1]!) <= 8_000, "the next request fits the limit");
  assert.ok(logOf(result).some((l) => l.type === "turn_capped"));
  // Largest-first shrinking: some results are cut (with the note), the rest stay whole.
  const cut = requests[1]!.filter((m) => m.role === "tool" && m.content!.includes("[Truncated at line"));
  assert.ok(cut.length >= 1);
  for (const m of cut) {
    assert.match(m.content!, /\[Truncated at line \d+ of 100\. Use read_file with offset=\d+ and limit to read more\.\]$/);
  }
});

test("A3: preflight shrinks the newest results so an oversized request is never sent", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 4; i++) files[`f${i}.txt`] = numbered(40);
  const dir = project(files);
  const read = (i: number) => ({ id: `r${i}`, name: "read_file", args: { path: `f${i}.txt` } });
  const { client, requests } = scripted((n) => {
    if (n === 0) return reply(null, [read(0), read(1)]);
    if (n === 1) return reply(null, [read(2), read(3)]);
    return reply("done");
  });
  // recentBudget = limit and a high threshold: compaction can't help, so preflight must.
  const result = await runAgent({
    task: "read",
    cwd: dir,
    client,
    quiet: true,
    contextLimit: 4_000,
    compactThreshold: 0.95,
    recentBudget: 4_000,
  });
  const pre = logOf(result).filter((l) => l.type === "preflight_truncated");
  assert.ok(pre.length > 0, "preflight_truncated logged");
  assert.ok(pre[0].estimate > 4_000);
  for (const req of requests) {
    assert.ok(estimateTokens(req) + estimateToolDefs([]) <= 4_000 * 1.02 + 1_800, "request near/below the limit");
  }
  // Direct check of the helper: newest results are shrunk first.
  const msgs: Message[] = [
    { role: "assistant", content: null, toolCalls: [{ id: "a", name: "read_file", args: { path: "a" } }] },
    { role: "tool", toolCallId: "a", name: "read_file", content: numbered(80) },
    { role: "assistant", content: null, toolCalls: [{ id: "b", name: "read_file", args: { path: "b" } }] },
    { role: "tool", toolCallId: "b", name: "read_file", content: numbered(80) },
  ];
  const s = shrinkNewest(msgs, 500, tokensOf);
  assert.deepEqual(s.shrunk, ["b"]);
  assert.equal(s.messages[1], msgs[1], "older result untouched");
});

// ---- A4 + A8: configuration ----

test("A8: precedence is option > env > .env > default, with sources", () => {
  const cfg = resolveConfig({ contextLimit: 9_000 }, { CONTEXT_LIMIT: "5000", COMPACT_THRESHOLD: "0.5", MAX_STEPS: "7" });
  assert.equal(cfg.contextLimit, 9_000);
  assert.equal(cfg.sources.contextLimit, "option");
  assert.equal(cfg.compactThreshold, 0.5);
  assert.equal(cfg.sources.compactThreshold, "env");
  assert.equal(cfg.maxSteps, 7);
  assert.equal(cfg.recentBudget, 3_600, "40% of the effective context limit");
  assert.equal(cfg.sources.recentBudget, "default");
  assert.equal(cfg.coverageCheck, true);
  assert.equal(cfg.coverageFooter, true);
  assert.equal(cfg.compactModel, undefined);
});

test("A8: invalid values fail with a clear message instead of falling back", () => {
  const bad: [Record<string, string>, RegExp][] = [
    [{ CONTEXT_LIMIT: "abc" }, /CONTEXT_LIMIT="abc" is not an integer/],
    [{ CONTEXT_LIMIT: "1500" }, /CONTEXT_LIMIT=1500 is out of range \(2000–/],
    [{ COMPACT_THRESHOLD: "0.99" }, /COMPACT_THRESHOLD=0.99 is out of range \(0\.1–0\.95\)/],
    [{ COMPACT_THRESHOLD: "0.05" }, /out of range/],
    [{ RECENT_BUDGET: "200000" }, /RECENT_BUDGET=200000 is out of range \(1–100000\)/],
    [{ COVERAGE_CHECK: "maybe" }, /COVERAGE_CHECK="maybe" must be on or off/],
    [{ COVERAGE_FOOTER: "2" }, /COVERAGE_FOOTER="2" must be on or off/],
    [{ MAX_STEPS: "0" }, /MAX_STEPS=0 is out of range/],
  ];
  for (const [env, msg] of bad) assert.throws(() => resolveConfig({}, env), (e: Error) => e instanceof ConfigError && msg.test(e.message), JSON.stringify(env));
  assert.throws(() => resolveConfig({ compactThreshold: 2 }, {}), /option compactThreshold=2 is out of range/);
});

test("A8: values from ~/.harness/.env are used below real env vars, and reported as '.env'", () => {
  const keys = ["COMPACT_THRESHOLD", "MAX_STEPS", "COVERAGE_FOOTER"];
  const saved = Object.fromEntries(Object.keys(process.env).map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    fs.mkdirSync(harnessHome(), { recursive: true });
    fs.writeFileSync(path.join(harnessHome(), ".env"), "COMPACT_THRESHOLD=0.5\nMAX_STEPS=7\nCOVERAGE_FOOTER=off\n");
    process.env.MAX_STEPS = "9"; // a real env var wins over the file
    loadEnv();
    const cfg = resolveConfig({}, process.env);
    assert.equal(cfg.compactThreshold, 0.5);
    assert.equal(cfg.sources.compactThreshold, ".env");
    assert.equal(cfg.coverageFooter, false);
    assert.equal(cfg.maxSteps, 9);
    assert.equal(cfg.sources.maxSteps, "env");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    envFileSources.clear();
    fs.rmSync(path.join(harnessHome(), ".env"), { force: true });
  }
});

test("A8: an invalid configuration stops runAgent with a clear error before any model call", async () => {
  let called = false;
  const client: LLMClient = { chat: async () => ((called = true), reply("x")) };
  const result = await runAgent({ task: "x", cwd: project({}), client, quiet: true, contextLimit: 100 });
  assert.equal(result.stopReason, "error");
  assert.match(result.error!, /^Invalid configuration: option contextLimit=100 is out of range/);
  assert.equal(called, false);
});

test("A8: eval runs get the same effective config regardless of env / .env values", () => {
  const polluted = {
    CONTEXT_LIMIT: "2500",
    COMPACT_THRESHOLD: "0.2",
    RECENT_BUDGET: "100",
    COMPACT_MODEL: "some-other-model",
    COVERAGE_CHECK: "off",
    COVERAGE_FOOTER: "off",
    MAX_STEPS: "3",
  };
  for (const task of tasks) {
    const settings = evalSettings(task, { mainModel: "gpt-test" });
    const clean = resolveConfig(settings, {});
    const dirty = resolveConfig(settings, polluted);
    assert.deepEqual(dirty, clean, task.id);
    for (const [key, source] of Object.entries(clean.sources)) assert.equal(source, "option", `${task.id}: ${key}`);
    assert.equal(clean.compactModel, "gpt-test");
  }
  assert.equal(resolveConfig(evalSettings(tasks[0]!, { mainModel: "m", compactModel: "cheap" }), {}).compactModel, "cheap");
});

test("A4: run_start logs every setting with its source, the model and the harness version", async () => {
  const { client } = scripted(() => reply("done"));
  const prev = process.env.COMPACT_THRESHOLD;
  process.env.COMPACT_THRESHOLD = "0.6";
  try {
    const result = await runAgent({ task: "x", cwd: project({}), client, quiet: true, contextLimit: 9_000 });
    const start = logOf(result).find((l) => l.type === "run_start");
    assert.ok(start);
    assert.equal(logOf(result)[0].type, "run_start", "first log entry");
    assert.equal(start.config.contextLimit, 9_000);
    assert.equal(start.config.sources.contextLimit, "option");
    assert.equal(start.config.compactThreshold, 0.6);
    assert.equal(start.config.sources.compactThreshold, "env");
    assert.equal(start.config.sources.maxSteps, "default");
    assert.equal(start.platform, process.platform);
    assert.match(start.harness.version, /^\d+\.\d+\.\d+$/);
    assert.equal(result.config!.contextLimit, 9_000);
  } finally {
    if (prev === undefined) delete process.env.COMPACT_THRESHOLD;
    else process.env.COMPACT_THRESHOLD = prev;
  }
});

// ---- A5: estimation and calibration ----

// Tuned from the Phase 4 measurement: ~0.7 tokens per CJK character, ~4 chars per token otherwise.
test("A5: CJK characters count ~0.7 tokens each, other text ~4 chars per token", () => {
  assert.equal(estimateText("abcdefgh"), 2);
  assert.equal(estimateText("你好世界"), Math.ceil(4 * 0.7));
  assert.equal(estimateText("中文 text"), Math.ceil(2 * 0.7 + 5 / 4));
  assert.equal(estimateText("こんにちは"), Math.ceil(5 * 0.7));
  assert.equal(estimateText("한국어"), Math.ceil(3 * 0.7));
  assert.equal(estimateText("中".repeat(1_000)), 700);
});

test("A5: the calibration ratio is an EMA of actual/estimated, clamped to 0.5–3.0", () => {
  const t = new ContextTracker();
  assert.equal(t.ratio, 1);
  assert.equal(t.record(1_500, 1, 1_000), 1.5);
  assert.equal(t.ratio, 1.5, "first observation is taken as is");
  t.record(2_000, 1, 1_000);
  assert.equal(t.ratio, 1.5 + 0.3 * (2 - 1.5));
  t.record(100_000, 1, 1_000);
  assert.equal(t.ratio, 3, "clamped high");
  const u = new ContextTracker();
  u.record(100, 1, 1_000);
  assert.equal(u.ratio, 0.5, "clamped low");
  assert.equal(new ContextTracker().tokensOf("abcdefg"), 2);
  assert.equal(u.tokensOf("abcdefg"), 1);
});

test("A5: the agent calibrates against the API's actual counts and reports the ratio", async () => {
  const client: LLMClient = {
    async chat(messages, tools) {
      const heuristic = estimateTokens(messages) + estimateToolDefs(tools);
      return { ...reply("done"), usage: { inputTokens: Math.round(heuristic * 1.8), outputTokens: 1 } };
    },
  };
  const result = await runAgent({ task: "hello", cwd: project({}), client, quiet: true });
  assert.ok(Math.abs(result.tokenRatio - 1.8) < 0.01, `ratio ${result.tokenRatio}`);
  const step = logOf(result).find((l) => l.type === "step");
  assert.ok(Math.abs(step.observedRatio - 1.8) < 0.01);
  assert.ok(step.heuristicTokens > 0);
});

// ---- A6: separate compaction model ----

test("A6: compaction calls go to the compaction client and are reported separately", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`f${i}.py`] = `def f${i}():\n    pass\n` + "# pad\n".repeat(600);
  const dir = project(files);
  let mainCompactionCalls = 0;
  let compactCalls = 0;
  const mainTotals = { inputTokens: 0, outputTokens: 0 };
  const main: LLMClient = {
    async chat(messages, tools) {
      if (tools.length === 0) mainCompactionCalls++;
      // Report realistic input counts (the heuristic), so the tracker's ground truth is sane.
      const u = { inputTokens: estimateTokens(messages) + estimateToolDefs(tools), outputTokens: 10 };
      mainTotals.inputTokens += u.inputTokens;
      mainTotals.outputTokens += u.outputTokens;
      const n = messages.filter((m) => m.role === "assistant").length;
      if (n < 5) return reply(null, [{ id: `r${n}`, name: "read_file", args: { path: `f${n}.py` } }], u);
      return reply("done", [], u);
    },
  };
  const compactClient: LLMClient = {
    async chat(messages) {
      compactCalls++;
      const ids = [...(messages.at(-1)!.content ?? "").matchAll(/### id: (\w+)/g)].map((m) => m[1]!);
      return reply(JSON.stringify(Object.fromEntries(ids.map((id) => [id, "A padded module."]))), [], { inputTokens: 7, outputTokens: 3 });
    },
  };
  const result = await runAgent({ task: "read", cwd: dir, client: main, compactClient, quiet: true, contextLimit: 6_000 });
  assert.ok(compactCalls > 0, "compaction used the compaction client");
  assert.equal(mainCompactionCalls, 0, "the main client made no compaction calls");
  assert.deepEqual(result.compactionUsage, { inputTokens: 7 * compactCalls, outputTokens: 3 * compactCalls, calls: compactCalls });
  assert.deepEqual(result.mainUsage, mainTotals);
  assert.deepEqual(result.usage, {
    inputTokens: mainTotals.inputTokens + 7 * compactCalls,
    outputTokens: mainTotals.outputTokens + 3 * compactCalls,
  });
});

// ---- A7: process-tree cleanup ----

test("A7: a timed-out command's child process does not survive", async () => {
  const dir = project({
    "spawner.js":
      'const { spawn } = require("child_process");\n' +
      'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });\n' +
      'require("fs").writeFileSync(__dirname + "/child.pid", String(c.pid));\n' +
      "setTimeout(() => {}, 60000);\n",
    "package.json": '{ "type": "commonjs" }\n',
  });
  const out = await runCommand("node spawner.js", dir, 1_500);
  assert.match(out, /^killed: timed out after 1\.5s \(process tree terminated\)/);
  const pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(pid); // don't leak it if the assertion fails
  assert.equal(alive, false, "grandchild process was killed");
});

test("A7: normal commands still report exit code, stdout and stderr", async () => {
  const out = (await runCommand("echo hi && exit 3", project({}), 10_000)).replace(/\r/g, "");
  assert.match(out, /^exit code: 3\nstdout:\nhi ?\n\nstderr:\n$/);
});
