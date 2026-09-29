// Workstream A: pinned known-files block, harness-computed coverage, Level 2 input/output
// rules, content-hash description cache, coverage check, decorated nested Python functions.
// Mocked LLM, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import type { Tool } from "../src/types.js";
import { elideToolResults, level2Input, sanitizeSummary, summarizeOlder, type Describer, type DescribeItem, type Summarizer } from "../src/context/compact.js";
import { Coverage, isWholeProjectTask, STATUS_PREFIX } from "../src/context/coverage.js";
import { parseListing, shellStdout } from "../src/context/listing.js";
import { ContextStore } from "../src/context/store.js";
import { extractSymbols, formatSymbols } from "../src/context/symbols.js";
import { runAgent } from "../src/agent.js";
import { tools as realTools } from "../src/tools/index.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A sandbox with the given files (relative path -> content). */
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-cov-"));
  created.push(dir);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}

const FILES = {
  "README.md": "# demo\n",
  "app/main.py": "def create_app():\n    pass\n",
  "app/agent.py": "class Agent:\n    def ask(self):\n        pass\n",
  "app/db.py": "def get_conn():\n    pass\n",
  "tests/test_agent.py": "def test_ask():\n    pass\n",
  ".venv/lib/site.py": "# vendored\n",
};
const LS_FILES = "README.md\napp/main.py\napp/agent.py\napp/db.py\ntests/test_agent.py\n";

// ---- Coverage: known files, reads, status block ----

test("known files come from listings; only real files under cwd, ignored dirs dropped", () => {
  const dir = project(FILES);
  const cov = new Coverage(dir);
  const listing = LS_FILES + "app/ghost.py\n.venv/lib/site.py\n";
  assert.equal(cov.addListing("run_shell", { command: "git ls-files" }, listing), 5);
  assert.deepEqual([...cov.known].sort(), ["README.md", "app/agent.py", "app/db.py", "app/main.py", "tests/test_agent.py"]);
  // A listing of a subdirectory with bare names resolves against the command's directory argument.
  const cov2 = new Coverage(dir);
  cov2.addListing("run_shell", { command: "dir /b app" }, "agent.py\ndb.py\nmain.py\n");
  assert.deepEqual([...cov2.known].sort(), ["app/agent.py", "app/db.py", "app/main.py"]);
  // Non-listing output adds nothing.
  assert.equal(cov.addListing("read_file", { path: "README.md" }, "# demo\n"), 0);
});

test("the unread-files list is computed by the harness and updates after reads", () => {
  const dir = project(FILES);
  const cov = new Coverage(dir);
  cov.addListing("run_shell", { command: "git ls-files" }, LS_FILES);
  assert.equal(cov.unread().length, 5);

  cov.markRead("./app\\agent.py"); // Windows-style and ./ prefixes normalize to the same file
  cov.markRead("app/db.py", true); // partial (offset/limit) read counts as read
  cov.markRead("../outside.py"); // outside cwd: ignored
  assert.deepEqual(cov.unread(), ["README.md", "app/main.py", "tests/test_agent.py"]);

  const status = cov.statusBlock("Summarize each source file")!;
  assert.ok(status.startsWith(STATUS_PREFIX));
  assert.match(status, /Known project files \(5\), from your listings: \.\/: README\.md; app\/: agent\.py, db\.py, main\.py; tests\/: test_agent\.py/);
  assert.match(status, /Read: 2 \(1 partially\) \/ Not yet read: 3/);
  assert.match(status, /Not yet read: \.\/: README\.md; app\/: main\.py; tests\/: test_agent\.py$/);

  cov.markRead("README.md");
  cov.markRead("app/main.py");
  cov.markRead("tests/test_agent.py");
  assert.match(cov.statusBlock("x")!, /Read: 5 \(1 partially\) \/ Not yet read: 0$/);
  assert.equal(new Coverage(dir).statusBlock("x"), null, "no block before any listing");
});

test("a large status block falls back to directory counts, keeping full paths for relevant directories", () => {
  const files: Record<string, string> = {};
  for (let d = 0; d < 12; d++) for (let f = 0; f < 40; f++) files[`pkg${d}/module_with_long_name_${f}.py`] = "x";
  const dir = project(files);
  const cov = new Coverage(dir);
  cov.addListing("run_shell", { command: "git ls-files" }, Object.keys(files).join("\n"));
  cov.markRead("pkg3/module_with_long_name_0.py");
  const status = cov.statusBlock("Explain what pkg7 does", 1_500)!;
  assert.ok(status.length / 4 <= 1_500 * 1.2, `status is ~${Math.round(status.length / 4)} tokens`);
  assert.match(status, /pkg0\/ \(40 files\)/);
  assert.match(status, /pkg7\/: module_with_long_name_0\.py, /, "directory named in the task keeps full paths");
  assert.match(status, /pkg3\/: module_with_long_name_0\.py, /, "directory with a read file keeps full paths");
});

test("whole-project task detection", () => {
  for (const t of ["List each source file and its purpose", "Summarize this project", "Give an overview of the codebase", "Describe all modules"]) {
    assert.ok(isWholeProjectTask(t), t);
  }
  for (const t of ["Fix the bug in sum.js", "How many lines does data.txt contain?", "Read ../secret.txt"]) {
    assert.ok(!isWholeProjectTask(t), t);
  }
});

// ---- Agent integration helpers ----

const reply = (text: string | null, toolCalls: LLMResponse["toolCalls"] = []): LLMResponse => ({
  text,
  toolCalls,
  usage: { inputTokens: 0, outputTokens: 0 },
  raw: null,
});

/** The exact result format of the real run_shell tool. */
const shellResult = (stdout: string) => `exit code: 0\nstdout:\n${stdout}\nstderr:\n`;

/** run_shell replaced by a stub that returns a fixed `git ls-files` output in the real format. */
const stubShell: Tool = {
  name: "run_shell",
  description: "stub",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  execute: async () => shellResult(LS_FILES),
};

test("listings wrapped in the real run_shell result format are parsed from stdout only", () => {
  const dir = project(FILES);
  const cov = new Coverage(dir);
  // Regression: "stdout:" used to be parsed as an `ls -R` header, prefixing every path with "stdout/".
  assert.equal(cov.addListing("run_shell", { command: "git ls-files" }, shellResult(LS_FILES)), 5);
  assert.deepEqual(parseListing(shellResult("app/a.py\napp/b.py\n")), ["app/a.py", "app/b.py"]);
  assert.equal(shellStdout(shellResult("x\ny")), "x\ny");
  assert.equal(shellStdout("plain output"), "plain output");
});
const tools = [...realTools.filter((t) => t.name !== "run_shell"), stubShell];
const call = (id: string, name: string, args: Record<string, unknown>) => [{ id, name, args }];

interface Seen {
  requests: Message[][];
  summarizerInputs: Message[][];
}

function scriptedClient(script: (n: number, messages: Message[]) => LLMResponse, summary = "summary text"): LLMClient & Seen {
  const seen: Seen = { requests: [], summarizerInputs: [] };
  return Object.assign(seen, {
    async chat(messages: Message[], toolDefs: unknown[]) {
      if (toolDefs.length === 0) {
        const isDescribe = /label tool results/.test(messages[0]!.content ?? "");
        if (isDescribe) return reply("{}");
        seen.summarizerInputs.push(messages);
        return reply(summary);
      }
      seen.requests.push(structuredClone(messages));
      return script(seen.requests.length - 1, messages);
    },
  });
}

// ---- Pinned listing survives Level 1 and Level 2 ----

test("the pinned file listing survives Level 1 and Level 2 compaction", async () => {
  const big = (n: number) => `# file ${n}\n` + "x = 1\n".repeat(900); // ~5.4k chars each
  const dir = project({ ...FILES, "app/main.py": big(1), "app/agent.py": big(2), "app/db.py": big(3), "tests/test_agent.py": big(4) });
  const order = ["app/main.py", "app/agent.py", "app/db.py", "tests/test_agent.py"]; // README.md stays unread
  const client = scriptedClient((n) => {
    if (n === 0) return reply("Listing files.", call("ls", "run_shell", { command: "git ls-files" }));
    // Notes large enough that the older span stays over Level 2's 1,000-token minimum after Level 1.
    if (n <= order.length) return reply(`Notes on step ${n}: ` + "n".repeat(4_500), call(`r${n}`, "read_file", { path: order[n - 1]! }));
    return reply("Final overview.");
  });
  const result = await runAgent({
    task: "Describe each source file",
    cwd: dir,
    client,
    tools,
    quiet: true,
    // Large enough that the per-result / preflight caps (Phase 4) don't shrink results below
    // the elision minimum, small enough that Level 1 and Level 2 both run.
    contextLimit: 12_000,
    compactThreshold: 0.7,
    coverageCheck: false,
  });

  assert.equal(result.stopReason, "done");
  assert.ok(result.compactionStats.level1 > 0, "Level 1 ran");
  assert.ok(result.compactionStats.level2Accepted > 0, "Level 2 ran");
  const last = client.requests.at(-1)!;
  // The original git ls-files result is gone from history (summarized away) ...
  assert.ok(!last.some((m) => m.role === "tool" && m.toolCallId === "ls"), "listing result was compacted away");
  // ... but every known file is still in the pinned status block sent with the request.
  const status = last.at(-1)!;
  assert.equal(status.role, "user");
  assert.ok(status.content!.startsWith(STATUS_PREFIX));
  for (const f of ["README.md", "main.py", "agent.py", "db.py", "test_agent.py"]) assert.ok(status.content!.includes(f), f);
  assert.match(status.content!, /Read: 4 \/ Not yet read: 1\nNot yet read: \.\/: README\.md$/);
  // The status block is attached per request, never stored in history.
  assert.equal(last.filter((m) => m.content?.startsWith(STATUS_PREFIX)).length, 1);
  assert.equal(result.coverage.known, 5);
  assert.deepEqual(result.coverage.unread, ["README.md"]);
});

// ---- Level 2 input and output rules ----

test("Level 2 input uses placeholders for described results and originals only for undescribed ones", async () => {
  const store = new ContextStore();
  const described = "[Elided: read_file app/a.py (5,000 chars). Symbols: class A: run. Description: Runner. This is a lossy summary — re-read the file if you need exact code, names, or details.]";
  const plain = "[Elided: read_file notes.txt (5,000 chars). This is a lossy summary — re-read the file if you need exact code, names, or details.]";
  store.record("d", "read_file", { path: "app/a.py" }, "ORIGINAL A " + "a".repeat(5_000));
  store.record("p", "read_file", { path: "notes.txt" }, "ORIGINAL NOTES " + "b".repeat(5_000));
  store.record("f", "read_file", { path: "b.py" }, "full content");
  const tool = (id: string, content: string) => ({ role: "tool" as const, toolCallId: id, name: "read_file", content });
  assert.equal(level2Input(tool("d", described), store), described);
  assert.match(level2Input(tool("p", plain), store), /^ORIGINAL NOTES/);
  assert.equal(level2Input(tool("f", "full content"), store), "full content");

  // Through summarizeOlder: the summarizer never sees the original of a described result.
  const msgs: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "t" }];
  for (const [i, [id, content]] of [["d", described], ["p", plain], ["x1", "y"], ["x2", "y"], ["x3", "y"]].entries()) {
    msgs.push({ role: "assistant", content: `turn ${i}`, toolCalls: [{ id: id!, name: "read_file", args: {} }] }, tool(id!, content!));
  }
  let input: Message[] = [];
  await summarizeOlder(msgs, async (older) => ((input = older), "s"), 3, store);
  const inputText = JSON.stringify(input);
  assert.ok(!inputText.includes("ORIGINAL A"), "described result passed as placeholder");
  assert.ok(inputText.includes("ORIGINAL NOTES"), "undescribed result passed as original");
});

test("the Level 2 summary keeps the model's remaining work but not its file lists or completion claims", () => {
  const model = [
    "Assistant notes: app/main.py wires routes; app/db.py wraps SQLite.",
    "Key findings: 3 routes.",
    "All files have been reviewed. No issues remain.",
    "Remaining work:",
    "- app/utils.py",
    "- tests/test_api.py, tests/test_db.py",
    "- Verify the /chat route handles streaming.",
    "The task is complete.",
  ].join("\n");
  const out = sanitizeSummary(model, "Unread files (harness-computed): tests/: test_api.py");
  assert.match(out, /Assistant notes: app\/main\.py wires routes/);
  assert.doesNotMatch(out, /no issues remain|task is complete|all files have been reviewed/i);
  assert.doesNotMatch(out, /app\/utils\.py|tests\/test_db\.py/, "model-written path lists removed");
  assert.match(out, /Remaining work:\n- Verify the \/chat route handles streaming\.\nUnread files \(harness-computed\): tests\/: test_api\.py$/);
  // No Remaining work section written by the model: the harness adds the heading.
  assert.match(sanitizeSummary("Notes only.", "Unread files (harness-computed): none"), /Notes only\.\n\nRemaining work:\nUnread files \(harness-computed\): none$/);
});

// ---- Description cache by content ----

function describerSpy() {
  const calls: DescribeItem[][] = [];
  const describe: Describer = async (items) => (calls.push(items), Object.fromEntries(items.map((i) => [i.id, `Describes ${i.label}.`])));
  return { calls, describe };
}

test("the description cache avoids a second model call for an unchanged file and regenerates on change", async () => {
  const content = "# notes\n" + "text line\n".repeat(300);
  const store = new ContextStore();
  const spy = describerSpy();
  const turn = (id: string, c: string): Message[] => [
    { role: "assistant", content: null, toolCalls: [{ id, name: "read_file", args: { path: "notes.md" } }] },
    { role: "tool", toolCallId: id, name: "read_file", content: c },
  ];
  const base: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "t" }];
  const now: Message[] = [{ role: "assistant", content: null, toolCalls: [{ id: "z", name: "run_shell", args: {} }] }, { role: "tool", toolCallId: "z", name: "run_shell", content: "ok" }];

  store.record("a", "read_file", { path: "notes.md" }, content);
  await elideToolResults([...base, ...turn("a", content), ...now], { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(spy.calls.length, 1);

  // Re-read of the same unchanged file under a new tool call id: no model call, same description.
  store.record("b", "read_file", { path: "notes.md" }, content);
  const again = await elideToolResults([...base, ...turn("b", content), ...now], { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(spy.calls.length, 1, "no second describer call");
  assert.match(again.messages[3]!.content!, /Description: Describes notes\.md\./);

  // Same path, changed content: described again.
  const changed = content + "new line\n";
  store.record("c", "read_file", { path: "notes.md" }, changed);
  await elideToolResults([...base, ...turn("c", changed), ...now], { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(spy.calls.length, 2);
  assert.deepEqual(spy.calls[1]!.map((i) => i.id), ["c"]);
});

// ---- Coverage check before finishing ----

async function coverageRun(opts: { reads: string[]; task?: string; coverageCheck?: boolean; env?: string }) {
  const dir = project(FILES);
  const client = scriptedClient((n) => {
    if (n === 0) return reply(null, call("ls", "run_shell", { command: "git ls-files" }));
    if (n <= opts.reads.length) return reply(null, call(`r${n}`, "read_file", { path: opts.reads[n - 1]! }));
    return reply(`Final answer ${n}`);
  });
  const prev = process.env.COVERAGE_CHECK;
  if (opts.env !== undefined) process.env.COVERAGE_CHECK = opts.env;
  try {
    const result = await runAgent({
      task: opts.task ?? "Describe each source file in this project",
      cwd: dir,
      client,
      tools,
      quiet: true,
      ...(opts.coverageCheck !== undefined && { coverageCheck: opts.coverageCheck }),
    });
    return { result, client };
  } finally {
    if (prev === undefined) delete process.env.COVERAGE_CHECK;
    else process.env.COVERAGE_CHECK = prev;
  }
}

const followUps = (client: Seen) =>
  client.requests.flat().filter((m, i, all) => m.role === "user" && m.content?.startsWith("You have not read these files") && all.indexOf(m) === i);

test("the coverage check fires once when listed files remain unread", async () => {
  const { result, client } = await coverageRun({ reads: ["app/main.py"] });
  assert.equal(result.stopReason, "done");
  assert.equal(result.nudges.coverage, 1);
  const last = client.requests.at(-1)!;
  const msg = last.find((m) => m.role === "user" && m.content?.startsWith("You have not read these files"));
  assert.ok(msg, "follow-up message was sent");
  assert.equal(
    msg!.content,
    "You have not read these files: ./: README.md; app/: agent.py, db.py; tests/: test_agent.py. " +
      "Either read the relevant ones, or state in your final answer which files/directories you did not cover. " +
      "Your next reply replaces your previous answer, so it must be complete — include everything from your " +
      "previous answer plus any additions.",
  );
  // The model answered twice; only one follow-up was sent, and the second answer was accepted.
  assert.equal(last.filter((m) => m.content?.startsWith("You have not read these files")).length, 1);
  // The second answer is kept (it is not shorter than 60% of the first), followed by the harness footer.
  assert.equal(
    result.finalText,
    `Final answer ${client.requests.length - 1}\n\n` +
      "--- Coverage (reported by harness): read 1 of 5 known files. Not read: README.md, app/agent.py, app/db.py, tests/test_agent.py.",
  );
  assert.deepEqual(result.answerHistory, ["Final answer 2", "Final answer 3"]);
});

test("the coverage check does not fire when all known files were read", async () => {
  const { result } = await coverageRun({ reads: ["README.md", "app/main.py", "app/agent.py", "app/db.py", "tests/test_agent.py"] });
  assert.equal(result.nudges.coverage, 0);
  assert.deepEqual(result.coverage.unread, []);
});

test("the coverage check does not fire when disabled (option or COVERAGE_CHECK=off) or for narrow tasks", async () => {
  assert.equal((await coverageRun({ reads: [], coverageCheck: false })).result.nudges.coverage, 0);
  assert.equal((await coverageRun({ reads: [], env: "off" })).result.nudges.coverage, 0);
  assert.equal((await coverageRun({ reads: [], env: "on" })).result.nudges.coverage, 1);
  assert.equal((await coverageRun({ reads: [], task: "Fix the bug in app/db.py" })).result.nudges.coverage, 0);
});

// ---- Decorated nested Python functions ----

test("decorated nested Python functions are extracted with their routes", () => {
  const py = `from fastapi import FastAPI

def create_app():
    app = FastAPI()

    def helper():  # undecorated nested function: skipped
        return 1

    @app.get("/chat")
    async def chat(q: str):
        return {"answer": q}

    @app.post('/ask', response_model=dict)
    def ask():
        pass

    @app.route("/legacy", methods=["POST", "put"])
    def legacy():
        pass

    @app.websocket("/ws")
    async def stream():
        pass

    @lru_cache(maxsize=1)
    def settings():
        pass

    return app


@router.get("/health")
def health():
    return "ok"


@dataclass
class Config:
    @property
    def url(self):
        return ""
`;
  const s = extractSymbols("app/main.py", py)!;
  assert.deepEqual(s.functions, [
    "create_app",
    "create_app > chat [GET /chat]",
    "create_app > ask [POST /ask]",
    "create_app > legacy [POST|PUT /legacy]",
    "create_app > stream [WS /ws]",
    "create_app > settings",
    "health [GET /health]",
  ]);
  assert.deepEqual(s.classes, [{ name: "Config", methods: ["url"] }]);
  assert.match(formatSymbols(s), /functions: create_app, create_app > chat \[GET \/chat\], create_app > ask \[POST \/ask\]/);
});
