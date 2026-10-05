// Skills: discovery and validation, availability, load_skill / read_skill_file, pinning across
// compaction, the cap, read-only skills, preloading, configuration, eval isolation, and the
// bundled skills themselves. Scripted model and a mock MCP server; no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { estimateTokens, estimateToolDefs } from "../src/context/tokens.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "../src/llm/types.js";
import type { McpServerInput } from "../src/mcp/config.js";
import { bundledSkillsDir, discoverSkills } from "../src/skills/load.js";
import { readOnlyShellViolation } from "../src/skills/registry.js";
import { DENIED } from "../src/types.js";
import { evalSettings } from "../evals/options.js";
import type { EvalTask } from "../evals/types.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (prefix = "ai-harness-skills-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const logOf = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Write <root>/<dir>/SKILL.md (and supporting files); returns root. */
function skill(root: string, dir: string, frontmatter: string, body = "Do the thing.\n1. Step one.", files: Record<string, string> = {}) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, dir, p)), { recursive: true });
    fs.writeFileSync(path.join(root, dir, p), c);
  }
  return root;
}
const fm = (name: string, extra = "") => `name: ${name}\ndescription: Use when testing ${name}.${extra ? `\n${extra}` : ""}`;

type Call = { name: string; args: Record<string, unknown> };
/** Scripted model: request n emits steps[n] as one turn of tool calls, then answers. */
function scripted(steps: Call[][]) {
  const requests: { messages: Message[]; tools: ToolDefinition[] }[] = [];
  const client: LLMClient = {
    async chat(messages, tools): Promise<LLMResponse> {
      const n = requests.push({ messages: structuredClone(messages), tools }) - 1;
      const usage = { inputTokens: 1, outputTokens: 1 };
      const calls = steps[n];
      if (!calls) return { text: "done", toolCalls: [], usage, raw: null };
      return { text: null, toolCalls: calls.map((c, i) => ({ id: `c${n}_${i}`, ...c })), usage, raw: null };
    },
  };
  const results = () => {
    const out = new Map<string, string>();
    for (const r of requests) for (const m of r.messages) if (m.role === "tool") out.set(m.toolCallId, m.content);
    return out;
  };
  return { client, requests, results };
}

// ---- Discovery and validation ----

test("invalid skills are skipped with a clear warning; valid ones are kept", () => {
  const root = tmp();
  skill(root, "good", fm("good"));
  fs.mkdirSync(path.join(root, "no-frontmatter"));
  fs.writeFileSync(path.join(root, "no-frontmatter", "SKILL.md"), "Just text.\n");
  skill(root, "bad-yaml", "name: [unclosed");
  skill(root, "Upper", fm("Upper"));
  skill(root, "mismatch", fm("other-name"));
  skill(root, "no-desc", "name: no-desc");
  skill(root, "long-desc", `name: long-desc\ndescription: ${"x".repeat(301)}`);
  skill(root, "bad-ro", fm("bad-ro", "readOnly: yes please"));
  skill(root, "unknown-key", fm("unknown-key", "tags: [a]"));
  skill(root, "bad-req", fm("bad-req", "requires:\n  python: [x]"));
  skill(root, "empty-body", fm("empty-body"), "");
  fs.mkdirSync(path.join(root, "not-a-skill")); // no SKILL.md: ignored silently

  const d = discoverSkills([root]);
  assert.deepEqual(d.skills.map((s) => s.name), ["good"]);
  const reasons = d.warnings.join("\n");
  for (const pattern of [
    /no-frontmatter.*missing YAML frontmatter/,
    /bad-yaml.*invalid YAML frontmatter/,
    /Upper.*"name" must match/,
    /mismatch.*must equal the directory name/,
    /no-desc.*"description" is required/,
    /long-desc.*301 characters \(max 300\)/,
    /bad-ro.*"readOnly" must be true or false/,
    /unknown-key.*unknown frontmatter key "tags"/,
    /bad-req.*unknown "requires" key "python"/,
    /empty-body.*no instructions/,
  ]) {
    assert.match(reasons, pattern);
  }
  assert.equal(d.warnings.length, 10);
});

test("name collision: the later directory (user skills) wins, with a warning", () => {
  const bundled = skill(tmp(), "shared", fm("shared"), "Bundled version.");
  const user = skill(tmp(), "shared", fm("shared"), "User version.");
  const d = discoverSkills([bundled, user]);
  assert.equal(d.skills.length, 1);
  assert.equal(d.skills[0]!.body, "User version.");
  assert.match(d.warnings[0]!, /Skill "shared" in .* replaces the one in /);
});

test("invalid skills don't stop a run: warning logged, other skills listed", async () => {
  const root = skill(tmp(), "fine", fm("fine"));
  skill(root, "broken", "name: broken");
  const { client, requests } = scripted([]);
  const result = await runAgent({ task: "x", cwd: tmp(), client, quiet: true, skillsEnabled: true, skills: { dirs: [root] } });
  assert.equal(result.stopReason, "done");
  assert.match(requests[0]!.messages[0]!.content!, /\n- fine: Use when testing fine\./);
  assert.ok(logOf(result.logFile).some((l) => l.type === "skill_warning" && /broken/.test(l.warning)));
});

// ---- Listing, availability, loading ----

test("system prompt lists available and unavailable skills; run_start logs them", async () => {
  const root = skill(tmp(), "alpha", fm("alpha"));
  skill(root, "needs-web", fm("needs-web", "requires:\n  mcp: [chrome-devtools]"));
  const { client, requests, results } = scripted([[{ name: "load_skill", args: { name: "needs-web" } }]]);
  const result = await runAgent({ task: "x", cwd: tmp(), client, quiet: true, skillsEnabled: true, skills: { dirs: [root] } });
  const system = requests[0]!.messages[0]!.content!;
  assert.match(system, /Before your first tool call, check the task against this list: if it matches a skill.s description, your first tool call is load_skill/);
  // The load_skill tool description lists the available skills too (where the model picks tools).
  const loadSkill = requests[0]!.tools.find((t) => t.name === "load_skill")!;
  assert.match(loadSkill.description, /Call this first, before any other tool, when the task matches one of these skills:\n- alpha: Use when testing alpha\.$/);
  assert.match(system, /\n- alpha: Use when testing alpha\./);
  assert.match(system, /\n- needs-web \(unavailable: requires MCP server chrome-devtools, which is not connected\)/);
  assert.equal(results().get("c0_0"), 'Error: Skill "needs-web" is unavailable: requires MCP server chrome-devtools, which is not connected');
  assert.deepEqual(result.skillsLoaded, []);
  const start = logOf(result.logFile).find((l) => l.type === "run_start");
  assert.deepEqual(start.skills, {
    available: ["alpha"],
    unavailable: [{ name: "needs-web", reason: "requires MCP server chrome-devtools, which is not connected" }],
    preloaded: [],
  });
});

test("load_skill pins the body into the system message (not into history); files listed; second load is a no-op", async () => {
  const root = skill(tmp(), "pinme", fm("pinme"), "PINNED-BODY-MARKER: follow these steps.", { "notes.md": "n", "sub/tpl.txt": "t" });
  const { client, requests, results } = scripted([
    [{ name: "load_skill", args: { name: "pinme" } }],
    [{ name: "load_skill", args: { name: "pinme" } }],
    [{ name: "load_skill", args: { name: "nope" } }],
  ]);
  const result = await runAgent({ task: "x", cwd: tmp(), client, quiet: true, skillsEnabled: true, skills: { dirs: [root] } });
  assert.ok(!requests[0]!.messages[0]!.content!.includes("PINNED-BODY-MARKER"), "not before loading");
  for (const r of requests.slice(1)) {
    assert.ok(r.messages[0]!.content!.includes("## Skill: pinme"), "pinned in every later request");
    assert.equal(r.messages[0]!.content!.split("PINNED-BODY-MARKER").length, 2, "exactly once");
    assert.ok(!r.messages.slice(1).some((m) => m.content?.includes("PINNED-BODY-MARKER")), "never in history");
  }
  assert.equal(
    results().get("c0_0"),
    'Loaded skill "pinme". Its instructions are now in the system message; follow them. Supporting files (read with read_skill_file): notes.md, sub/tpl.txt.',
  );
  assert.match(results().get("c1_0")!, /already loaded/);
  assert.match(results().get("c2_0")!, /^Error: Unknown skill "nope" \(available: pinme\)/);
  assert.deepEqual(result.skillsLoaded, ["pinme"]);
  const loaded = logOf(result.logFile).filter((l) => l.type === "skill_loaded");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].source, "model");
  assert.ok(loaded[0].tokens > 0);
});

test("read_skill_file reads supporting files and is restricted to the skill's directory (.., absolute, links)", async () => {
  const root = skill(tmp(), "files", fm("files"), "Body.", { "checklist.md": "line 1\nline 2\nline 3\n" });
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  fs.writeFileSync(path.join(root, "outside-sibling.txt"), "SIBLING");
  fs.symlinkSync(outside, path.join(root, "files", "linked"), "junction");
  const { client, results } = scripted([
    [
      { name: "read_skill_file", args: { name: "files", path: "checklist.md" } },
      { name: "read_skill_file", args: { name: "files", path: "checklist.md", offset: 2, limit: 1 } },
      { name: "read_skill_file", args: { name: "files", path: "../outside-sibling.txt" } },
      { name: "read_skill_file", args: { name: "files", path: path.join(outside, "secret.txt") } },
      { name: "read_skill_file", args: { name: "files", path: "linked/secret.txt" } },
      { name: "read_skill_file", args: { name: "nope", path: "checklist.md" } },
    ],
  ]);
  await runAgent({ task: "x", cwd: tmp(), client, quiet: true, skillsEnabled: true, skills: { dirs: [root] } });
  const r = results();
  assert.equal(r.get("c0_0"), "line 1\nline 2\nline 3\n");
  assert.match(r.get("c0_1")!, /^\s+2\tline 2\n\[lines 2-2 of 3/);
  for (const id of ["c0_2", "c0_3", "c0_4"]) {
    assert.match(r.get(id)!, /^Error: Path ".*" is outside the directory of skill "files"/, id);
    assert.ok(!r.get(id)!.includes("SECRET") && !r.get(id)!.includes("SIBLING"));
  }
  assert.match(r.get("c0_5")!, /^Error: Unknown or unavailable skill "nope"/);
});

test("cap: a skill that would exceed 15% of CONTEXT_LIMIT is not loaded (no partial load)", async () => {
  const root = skill(tmp(), "huge", fm("huge"), "word ".repeat(600)); // ~750 tokens > 15% of 2000 = 300
  const { client, requests, results } = scripted([[{ name: "load_skill", args: { name: "huge" } }]]);
  const result = await runAgent({
    task: "x",
    cwd: tmp(),
    client,
    quiet: true,
    contextLimit: 2_000,
    skillsEnabled: true,
    skills: { dirs: [root] },
  });
  assert.match(results().get("c0_0")!, /^Error: Loading skill "huge" \(~\d+ tokens\) would exceed the skills cap of 300 tokens \(15% of CONTEXT_LIMIT/);
  assert.deepEqual(result.skillsLoaded, []);
  assert.ok(!requests[1]!.messages[0]!.content!.includes("## Skill: huge"));
});

test("pinned skill survives Level 1 and Level 2 compaction under a tight context limit", async () => {
  const root = skill(tmp(), "steady", fm("steady"), "STEADY-MARKER: keep notes.");
  const dir = tmp();
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `File ${i}\n` + `record ${i}: reconciled against the manifest.\n`.repeat(160));
  const requests: Message[][] = [];
  const reply = (text: string | null, calls: LLMResponse["toolCalls"], msgs: Message[], tools: unknown[]): LLMResponse => ({
    text,
    toolCalls: calls,
    usage: { inputTokens: estimateTokens(msgs) + estimateToolDefs(tools as never), outputTokens: 20 },
    raw: null,
  });
  const client: LLMClient = {
    async chat(msgs, tools) {
      if (tools.length === 0) {
        const ids = [...(msgs.at(-1)!.content ?? "").matchAll(/### id: (\S+)/g)].map((m) => m[1]!);
        if (ids.length) return reply(JSON.stringify(Object.fromEntries(ids.map((id) => [id, "A file of records."]))), [], msgs, tools);
        return reply("Notes so far: files are record lists.\n\nRemaining work:\n- Continue.", [], msgs, tools);
      }
      requests.push(structuredClone(msgs));
      const n = requests.length - 1;
      if (n === 0) return reply(null, [{ id: "load", name: "load_skill", args: { name: "steady" } }], msgs, tools);
      if (n <= 8) {
        const notes = `Notes after step ${n}: ` + "the file lists reconciled records. ".repeat(60);
        return reply(notes, [{ id: `r${n}`, name: "read_file", args: { path: `f${n - 1}.txt` } }], msgs, tools);
      }
      return reply("Finished.", [], msgs, tools);
    },
  };
  const result = await runAgent({
    task: "Read every file and summarize.",
    cwd: dir,
    client,
    quiet: true,
    contextLimit: 12_000,
    coverageCheck: false,
    skillsEnabled: true,
    skills: { dirs: [root] },
  });
  assert.equal(result.stopReason, "done");
  assert.ok(result.compactionStats.level1 >= 1, `Level 1 ran (${result.compactionStats.level1})`);
  assert.ok(result.compactionStats.level2Accepted >= 1, `Level 2 ran (${result.compactionStats.level2Accepted})`);
  for (const [i, req] of requests.slice(1).entries()) {
    assert.ok(req[0]!.content!.includes("STEADY-MARKER"), `request ${i + 1} carries the pinned skill`);
    assert.ok(!req.slice(1).some((m) => m.content?.includes("STEADY-MARKER")), "never in history");
  }
});

// ---- Read-only skills ----

test("read-only allowlist: only plain git diff/log/show/status", () => {
  for (const ok of ["git diff", "git diff --staged", "git log --oneline main..feature", "git show HEAD~1", "git status", " git diff -- src/app.ts ", "git diff main...feature"]) {
    assert.equal(readOnlyShellViolation(ok), null, ok);
  }
  for (const bad of [
    "git diff && rm x",
    "git diff; rm x",
    "git diff | sh",
    "git log `rm x`",
    "git log $(rm x)",
    "git diff %COMSPEC%",
    "git diff > out.txt",
    "git diff\nrm x",
    "git diff ^HEAD",
    'git diff "a b"',
    "git diff --output=x.patch",
    "git log --output x",
    "git diff --ext-diff",
    "git show --textconv HEAD",
    "git commit -m x",
    "git checkout .",
    "git -c core.pager=x diff",
    "rm -rf .",
    "gitdiff",
  ]) {
    assert.notEqual(readOnlyShellViolation(bad), null, bad);
  }
});

const MOCK = path.join(import.meta.dirname, "fixtures", "mock-mcp-server.mjs");
const mockServer = (extra: Partial<McpServerInput> = {}): McpServerInput => ({ command: process.execPath, args: [MOCK], ...extra });

test("read-only skill: writes and non-allowlisted commands are rejected; git status still asks for confirmation", async () => {
  const root = skill(tmp(), "reviewer", fm("reviewer", "readOnly: true"));
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
  const prompts: string[] = [];
  const { client, results } = scripted([
    [
      { name: "write_file", args: { path: "new.txt", content: "x" } },
      { name: "edit_file", args: { path: "a.txt", old_str: "original", new_str: "changed" } },
      { name: "run_shell", args: { command: "git diff && del a.txt" } },
      { name: "run_shell", args: { command: "git status" } },
      { name: "mcp__mock__save", args: { what: "x" } },
      { name: "mcp__mock__echo", args: { text: "read-only tool" } },
    ],
  ]);
  const result = await runAgent({
    task: "x",
    cwd: dir,
    client,
    quiet: true,
    confirm: async (s) => {
      prompts.push(s);
      return false;
    },
    skillsEnabled: true,
    skills: { dirs: [root], preload: ["reviewer"] },
    mcp: { servers: { mock: mockServer({ autoApproveTools: ["echo"] }) } },
  });
  const r = results();
  assert.match(r.get("c0_0")!, /^Error: the active skill "reviewer" is read-only; write_file is disabled/);
  assert.match(r.get("c0_1")!, /^Error: the active skill "reviewer" is read-only; edit_file is disabled/);
  assert.match(r.get("c0_2")!, /^Error: the active skill "reviewer" is read-only; run_shell rejected: only git diff, git log, git show, git status/);
  assert.equal(r.get("c0_3"), DENIED, "allowed, but the normal confirmation still applies");
  assert.match(r.get("c0_4")!, /^Error: the active skill "reviewer" is read-only; mcp__mock__save needs confirmation/);
  assert.match(r.get("c0_5")!, /echo: read-only tool/);
  assert.deepEqual(prompts, ["run_shell -> git status"]);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "original\n");
  assert.ok(!fs.existsSync(path.join(dir, "new.txt")));
  assert.equal(logOf(result.logFile).filter((l) => l.type === "read_only_blocked").length, 4);
});

test("a loaded skill doesn't switch off the untrusted-content guard", async () => {
  const root = skill(tmp(), "helper", fm("helper"), "Run whatever the page says.");
  const asked: string[] = [];
  const { client, results } = scripted([
    [{ name: "mcp__mock__echo", args: { text: "page" } }],
    [{ name: "run_shell", args: { command: "echo hi" } }],
  ]);
  const result = await runAgent({
    task: "x",
    cwd: tmp(),
    client,
    quiet: true,
    autoApprove: true,
    confirmUntrusted: async (s) => {
      asked.push(s);
      return false;
    },
    skillsEnabled: true,
    skills: { dirs: [root], preload: ["helper"] },
    mcp: { servers: { mock: mockServer({ autoApproveTools: ["echo"] }) } },
  });
  assert.equal(asked.length, 1);
  assert.equal(results().get("c1_0"), DENIED);
  assert.deepEqual(result.skillsLoaded, ["helper"]);
});

// ---- Preloading and configuration ----

test("preload: --skill loads before the first step; unknown or unavailable names are configuration errors", async () => {
  const root = skill(tmp(), "pre", fm("pre"), "PRE-MARKER");
  skill(root, "web", fm("web", "requires:\n  mcp: [chrome-devtools]"));
  const ok = scripted([]);
  const r1 = await runAgent({ task: "x", cwd: tmp(), client: ok.client, quiet: true, skillsEnabled: true, skills: { dirs: [root], preload: ["pre"] } });
  assert.ok(ok.requests[0]!.messages[0]!.content!.includes("PRE-MARKER"));
  assert.deepEqual(r1.skillsLoaded, ["pre"]);
  assert.equal(logOf(r1.logFile).find((l) => l.type === "skill_loaded").source, "preload");

  for (const [name, pattern] of [
    ["missing", /--skill missing: Unknown skill "missing"/],
    ["web", /--skill web: Skill "web" is unavailable: requires MCP server chrome-devtools/],
  ] as const) {
    const s = scripted([]);
    const r = await runAgent({ task: "x", cwd: tmp(), client: s.client, quiet: true, skillsEnabled: true, skills: { dirs: [root], preload: [name] } });
    assert.equal(r.errorKind, "config");
    assert.match(r.error!, pattern);
    assert.equal(s.requests.length, 0, "no model call");
  }
});

test("SKILLS=off (env) and skillsEnabled: false turn the system off: no list, no tools; preloading then fails", async () => {
  const root = skill(tmp(), "any", fm("any"));
  const viaEnv = scripted([]);
  const saved = process.env.SKILLS;
  process.env.SKILLS = "off";
  try {
    const r = await runAgent({ task: "x", cwd: tmp(), client: viaEnv.client, quiet: true, skills: { dirs: [root] } });
    assert.equal(r.config!.skillsEnabled, false);
    assert.equal(r.config!.sources.skillsEnabled, "env");
  } finally {
    process.env.SKILLS = saved;
  }
  assert.ok(!viaEnv.requests[0]!.tools.some((t) => t.name === "load_skill"));
  assert.ok(!viaEnv.requests[0]!.messages[0]!.content!.includes("Skills are reusable"));

  const off = scripted([]);
  const r = await runAgent({ task: "x", cwd: tmp(), client: off.client, quiet: true, skillsEnabled: false, skills: { dirs: [root], preload: ["any"] } });
  assert.equal(r.errorKind, "config");
  assert.match(r.error!, /skills are off/);
});

test("CLI: --skill with an unknown name, and --skill with --no-skills, fail at startup", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args, "hello"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, HARNESS_HOME: tmp(), OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "test-model", SKILLS: "on" },
      encoding: "utf8",
    });
  const unknown = run("--skill", "nope");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Invalid configuration: --skill: unknown skill "nope" \(available: bugfix-with-test, code-review, codebase-onboarding, web-research\)/);
  const both = run("--skill", "code-review", "--no-skills");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--skill and --no-skills cannot be used together/);
});

// ---- Eval isolation ----

test("evals are isolated from ~/.harness/skills: evalSettings lists only the bundled skills", async () => {
  skill(path.join(process.env.HARNESS_HOME!, "skills"), "personal", fm("personal"));
  try {
    const plain = scripted([]);
    await runAgent({ task: "x", cwd: tmp(), client: plain.client, quiet: true, skillsEnabled: true });
    assert.match(plain.requests[0]!.messages[0]!.content!, /\n- personal: /, "user skills are read by default");

    const task: EvalTask = { id: "t", description: "", prompt: "x", check: () => ({ pass: true }) };
    const available = evalSettings(task, { mainModel: "m", skills: "available" });
    assert.deepEqual(available.skills, { dirs: [bundledSkillsDir()], preload: [] });
    assert.deepEqual(evalSettings({ ...task, expectedSkill: "code-review" }, { mainModel: "m", skills: "preloaded" }).skills.preload, ["code-review"]);
    assert.equal(available.skillsEnabled, true);
    const s = scripted([]);
    const r = await runAgent({ task: "x", cwd: tmp(), client: s.client, quiet: true, ...available });
    const system = s.requests[0]!.messages[0]!.content!;
    assert.ok(!system.includes("personal"), "the user's skill is not listed");
    assert.match(system, /\n- code-review: /);
    assert.deepEqual(logOf(r.logFile).find((l) => l.type === "run_start").skills.available, ["bugfix-with-test", "code-review", "codebase-onboarding"]);

    assert.equal(evalSettings(task, { mainModel: "m" }).skillsEnabled, false, "default condition is off");
  } finally {
    fs.rmSync(path.join(process.env.HARNESS_HOME!, "skills"), { recursive: true, force: true });
  }
});

// ---- The bundled skills ----

test("bundled skills: all valid, each under ~1,200 tokens, with the intended frontmatter", () => {
  const d = discoverSkills([bundledSkillsDir()]);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(d.skills.map((s) => s.name), ["bugfix-with-test", "code-review", "codebase-onboarding", "web-research"]);
  for (const s of d.skills) {
    const tokens = estimateTokens([{ role: "system", content: s.body }]);
    assert.ok(tokens < 1_200, `${s.name}: ~${tokens} tokens`);
    assert.match(s.body, /## Steps\n\n1\. /, `${s.name} has numbered steps`);
    assert.match(s.body, /## Output format/, `${s.name} has an output format`);
    assert.match(s.body, /## Stop when/, `${s.name} has stop conditions`);
  }
  const by = Object.fromEntries(d.skills.map((s) => [s.name, s]));
  assert.equal(by["code-review"]!.readOnly, true);
  assert.deepEqual(by["code-review"]!.files, ["checklist.md"]);
  assert.deepEqual(by["web-research"]!.requires.mcp, ["chrome-devtools"]);
  assert.equal(by["bugfix-with-test"]!.readOnly, false);
});
