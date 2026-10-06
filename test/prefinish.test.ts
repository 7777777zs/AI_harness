// Pre-finish checks: plan-only replies, skill completion criteria, and the shared follow-up
// budget (with the coverage check). Scripted model; no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, totalNudges, type NudgeStats } from "../src/agent.js";
import { resolveConfig } from "../src/config.js";
import type { LLMClient, Message } from "../src/llm/types.js";
import { completionGaps, isPlanOnly } from "../src/prefinish.js";
import type { Skill } from "../src/skills/load.js";
import { evalSettings } from "../evals/options.js";
import type { EvalTask } from "../evals/types.js";

// ---- Plan-only detection ----

test("plan-only replies: the reply ends by announcing work instead of reporting it", () => {
  for (const plan of [
    // Real gpt-4.1 endings (web-research, Phase 6 follow-up).
    "- The Riverton city archive page lists several links:\n  1. City page\n  2. Encyclopedia\n\nI will read each of these pages to gather information on when the Harbor Point Bridge opened and its length.",
    "Here are the candidate sources as required by step 2 of the web-research skill, then proceed to read them for facts about the opening date and length of the Harbor Point Bridge.",
    "Next step: read src/duration.js and write a failing test.",
    "Let me open the release notes page to find the deployment code.",
    "I'll now check the remaining files under src/.",
    "接下来我将逐个打开这些页面，查找大桥的开通年份和长度。",
    "下一步：运行测试，确认新加的测试会失败。",
  ]) {
    assert.equal(isPlanOnly(plan), true, plan);
  }
});

test("genuine final answers are not plans, even when they mention future work or offer help", () => {
  for (const answer of [
    "The Harbor Point Bridge opened in 1931 (http://x/city.html) and is 412 m long.",
    "## Root cause\n`src/duration.js:15` strips the 0 of 30s.\n\n## Results\nNew test: PASS. Full suite: 7 passed.",
    "Done. I created notes/greeting.txt.\n\nLet me know if you need anything else.",
    "The file contains 137 lines.\n\nIf you want, I can also count the words.",
    "I will not modify check.js, as requested; the fix is in sum.js line 3.",
    "Summary:\n- api/: HTTP handlers\n- services/: business logic\n\nNext steps for you: run `npm test` to verify.",
    "已完成：把 timeout 从 30 改成了 60，文件其他内容没有变。",
    "这个项目分为三层：api 处理请求，services 负责业务逻辑，store 负责持久化。如有需要我可以再详细说明。",
  ]) {
    assert.equal(isPlanOnly(answer), false, answer);
  }
});

// ---- The pre-finish check in the agent loop ----

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-prefinish-"));
  created.push(d);
  return d;
};
const logOf = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** A skills directory with one skill "cite" whose frontmatter has `completion`. */
function citeSkill(completion: string): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, "cite"));
  fs.writeFileSync(
    path.join(root, "cite", "SKILL.md"),
    `---\nname: cite\ndescription: Use when testing citations.\ncompletion:\n${completion}\n---\nCite sources.\n`,
  );
  return root;
}
const MACHINE = "  requiredSections: ['^#+\\s*Conflicts']\n  minDistinctUrls: 2\n  text:\n    - Every claim has its URL.";
const GOOD = "## Answer\nOpened 1931 (http://a/1) and 412 m (http://a/2).\n\n## Conflicts\nThe blog says 1932 (http://a/3).";

type Reply = string | { tool: string; args: Record<string, unknown> };
/** Scripted model: replies in order (a string is a final answer, an object a tool call). */
function scripted(replies: Reply[]) {
  const requests: Message[][] = [];
  const client: LLMClient = {
    async chat(messages) {
      requests.push(structuredClone(messages));
      const r = replies[requests.length - 1] ?? "done";
      const usage = { inputTokens: 1, outputTokens: 1 };
      return typeof r === "string"
        ? { text: r, toolCalls: [], usage, raw: null }
        : { text: null, toolCalls: [{ id: `c${requests.length}`, name: r.tool, args: r.args }], usage, raw: null };
    },
  };
  /** The harness's follow-up messages (user messages after the task, without the per-request status block). */
  const followUps = () =>
    requests.at(-1)!.filter((m, i) => m.role === "user" && i > 1 && !m.content!.startsWith("[Harness status")).map((m) => m.content!);
  return { client, requests, followUps };
}
const run = (client: LLMClient, extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({ task: "Find the facts.", cwd: tmp(), client, quiet: true, coverageCheck: false, ...extra });
const withCite = (completion: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
  skillsEnabled: true,
  skills: { dirs: [citeSkill(completion)], preload: ["cite"] },
  ...extra,
});

test("a plan-only reply gets one 'do it now' follow-up and is not kept as an answer", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.txt"), "facts");
  const s = scripted(["I will read a.txt to find the facts.", { tool: "read_file", args: { path: "a.txt" } }, "The facts are: facts."]);
  const result = await runAgent({ task: "Find the facts.", cwd: dir, client: s.client, quiet: true, coverageCheck: false });
  assert.equal(result.stopReason, "done");
  assert.equal(result.finalText, "The facts are: facts.");
  assert.deepEqual(result.answerHistory, ["The facts are: facts."], "the plan is not an answer");
  assert.equal(s.followUps().length, 1);
  assert.match(s.followUps()[0]!, /^Your reply only describes what you are going to do/);
  assert.equal(result.nudges.plan, 1);
  assert.ok(logOf(result.logFile).some((l) => l.type === "nudge" && l.kind === "plan"));
});

test("completion criteria: failing machine rules get one follow-up naming them (and the text criteria)", async () => {
  const s = scripted(["The bridge opened in 1931 and is 412 m long (http://a/1).", GOOD]);
  const result = await run(s.client, withCite(MACHINE));
  assert.equal(result.finalText, GOOD);
  const [msg] = s.followUps();
  assert.match(msg!, /completion criteria of the "cite" skill/);
  assert.match(msg!, /- a section matching \/\^#\+\\s\*Conflicts\/ is missing/);
  assert.match(msg!, /- at least 2 distinct URLs are required; the answer has 1/);
  assert.match(msg!, /- Every claim has its URL\./);
  assert.equal(result.nudges.completion, 1);
  assert.ok(logOf(result.logFile).some((l) => l.type === "nudge" && l.kind === "completion"));
});

test("completion criteria: no follow-up when the machine rules pass, even with text criteria", async () => {
  const s = scripted([GOOD]);
  const result = await run(s.client, withCite(MACHINE));
  assert.equal(s.requests.length, 1);
  assert.equal(result.nudges.completion, 0);
});

test("completion criteria: text-only criteria always get one follow-up", async () => {
  const s = scripted(["An answer.", "An answer, checked."]);
  const result = await run(s.client, withCite("  text:\n    - Every claim has its URL."));
  assert.equal(s.requests.length, 2);
  assert.match(s.followUps()[0]!, /- Every claim has its URL\./);
  assert.equal(result.finalText, "An answer, checked.");
});

test("the follow-ups share a budget (PREFINISH_MAX, default 2): the plan nudge doesn't use up the answer check", async () => {
  // Budget 2: plan nudge, then the completion check on the real answer; the third reply is accepted.
  const two = scripted(["I will read the pages now.", "Opened 1931.", "Opened 1931, still no sources."]);
  const r2 = await run(two.client, withCite(MACHINE));
  assert.equal(two.requests.length, 3);
  assert.deepEqual([r2.nudges.plan, r2.nudges.completion], [1, 1]);
  assert.match(r2.finalText!, /Opened 1931, still no sources\.$/);
  // Budget 1: the plan nudge uses it; the real answer is accepted unchecked.
  const one = scripted(["I will read the pages now.", "Opened 1931."]);
  const r1 = await run(one.client, withCite(MACHINE, { prefinishMax: 1 }));
  assert.equal(one.requests.length, 2);
  assert.deepEqual([r1.nudges.plan, r1.nudges.completion], [1, 0]);
  // Budget 0: no follow-ups at all.
  const none = scripted(["I will read the pages now."]);
  assert.equal((await run(none.client, withCite(MACHINE, { prefinishMax: 0 }))).finalText, "I will read the pages now.");
  assert.equal(none.requests.length, 1);
});

test("coverage and completion failing on the same answer go out as one follow-up", async () => {
  const dir = tmp();
  for (const f of ["a.py", "b.py", "c.py"]) fs.writeFileSync(path.join(dir, f), "x = 1\n");
  const s = scripted([{ tool: "list_dir", args: {} }, "Overview: a.py sets x.", GOOD]);
  const result = await runAgent({
    task: "Give an overview of this project.",
    cwd: dir,
    client: s.client,
    quiet: true,
    coverageCheck: true,
    ...withCite(MACHINE),
  });
  const msgs = s.followUps();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0]!, /You have not read these files/);
  assert.match(msgs[0]!, /completion criteria of the "cite" skill/);
  assert.deepEqual([result.nudges.coverage, result.nudges.completion], [1, 1]);
});

test("A1 still protects a fuller answer after a completion follow-up", async () => {
  const long = "## Answer\n" + "Opened 1931 with many details. ".repeat(20) + "(http://a/1)";
  const s = scripted([long, "## Conflicts\nNone found (http://a/1, http://a/2)."]);
  const result = await run(s.client, withCite(MACHINE));
  assert.ok(result.finalText!.startsWith(long), "the earlier, fuller answer is kept");
  assert.match(result.finalText!, /--- \(continued after the harness check\) ---/);
});

test("PREFINISH_MAX is validated and set explicitly by the eval settings", () => {
  assert.throws(() => resolveConfig({}, { PREFINISH_MAX: "-1" }), /PREFINISH_MAX=-1 is out of range \(0–10\)/);
  assert.equal(resolveConfig({}, {}).prefinishMax, 2);
  const task: EvalTask = { id: "t", description: "", prompt: "x", check: () => ({ pass: true }) };
  assert.equal(evalSettings(task, { mainModel: "m" }).prefinishMax, 2);
});

test("totalNudges counts every kind of nudge, including the pre-finish ones (plan, completion)", () => {
  // Distinct powers of two: a missing or doubled kind changes the sum.
  const stats: NudgeStats = { notes: 1, missingFile: 2, repeat: 4, coverage: 8, plan: 16, completion: 32, unopenedUrl: 64 };
  assert.equal(totalNudges(stats), 127);
});

test("requiredSections match heading lines only (Markdown headings or bold-only lines), not body text", () => {
  const skill = (requiredSections: string[]): Skill => ({
    name: "s",
    description: "d",
    requires: { mcp: [], tools: [] },
    readOnly: false,
    body: "b",
    dir: ".",
    files: [],
    completion: { requiredSections, text: [] },
  });
  const gaps = (pattern: string, answer: string) => completionGaps(answer, [skill([pattern])]).length;
  // A body mention is not a section.
  assert.equal(gaps("Conflicts", "## Answer\nThere are no conflicts between the sources."), 1);
  // Headings are.
  assert.equal(gaps("Conflicts", "## Answer\nx\n\n## Conflicts\nNone found."), 0);
  assert.equal(gaps("Conflicts", "**Answer**\nx\n\n**Conflicts**\nNone found."), 0);
  // web-research's own pattern still works.
  assert.equal(gaps("^#+\\s*Conflicts", "## Answer\nx\n\n## Conflicts\nNone found."), 0);
  assert.equal(gaps("^#+\\s*Conflicts", "## Answer\nThe conflicts are listed below."), 1);
});
