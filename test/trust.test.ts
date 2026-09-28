// Trustworthy compaction: symbol extraction, description validation, listing preservation,
// describer batching, and harness nudges. Mocked LLM, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import { elideToolResults, MIN_ELIDE_CHARS, unknownIdentifier, type Describer, type DescribeItem } from "../src/context/compact.js";
import { compressListing, isListing, parseListing } from "../src/context/listing.js";
import { ContextStore } from "../src/context/store.js";
import { batchItems, DESCRIBE_MAX_CHARS, makeDescriber } from "../src/context/summarize.js";
import { extractSymbols, formatSymbols } from "../src/context/symbols.js";
import { MISSING_FILE_HINT, NOTE_NUDGE, runAgent } from "../src/agent.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sandbox = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-trust-"));
  created.push(d);
  return d;
};

// ---- Symbol extraction ----

const PY = `"""Insight agent.

def not_a_function(): this is prose inside the module docstring
class NotAClass: also prose
"""
import json

class InsightAgent:
    """Answers questions."""

    def __init__(self, llm):
        self.llm = llm

        def helper():  # nested function: not a method
            return 1

    def ask(self, question):
        return self._inputs(question)

    async def stream(self, question):
        yield question

    def _inputs(self, question):
        return question

    def _remember(self, q, a):
        pass


class Store:
    def load(self):
        pass


async def main():
    class Local:  # local class: skipped
        def run(self):
            pass
    return 1


def build_app():
    pass

EVENTS = {"chat_event": "ui.chat"}
`;

test("Python: methods are grouped under their class; async, nested and docstring text handled", () => {
  const s = extractSymbols("app/agent.py", PY)!;
  assert.deepEqual(s.classes, [
    { name: "InsightAgent", methods: ["ask", "stream", "_inputs", "_remember"] },
    { name: "Store", methods: ["load"] },
  ]);
  assert.deepEqual(s.functions, ["main", "build_app"]);
  assert.equal(formatSymbols(s), "class InsightAgent: ask, stream, _inputs, _remember; class Store: load; functions: main, build_app");
});

const TS = `import x from "y";
/* class Commented { fake() {} } */
export default class Store<T> {
  private items: T[] = [];
  constructor() {}
  async load(id: string): Promise<T> {
    if (id) { return this.items[0]; }
    const s = "{ not a brace";
    return this.items[1];
  }
  static create(): Store<number> { return new Store(); }
  get size() { return 1; }
  #secret() {}
}
class Plain {
  run() { for (const a of []) {} }
}
export function helper(a: number) { return a; }
export async function fetchData() {}
export const toJson = (x: unknown) => JSON.stringify(x);
export const fetchAll = async (): Promise<void> => {};
const notAnArrow = 5;
function topLevel() { function inner() {} }
`;

test("JS/TS: classes, methods, functions and exported arrow functions", () => {
  const s = extractSymbols("src/store.ts", TS)!;
  assert.deepEqual(s.classes, [
    { name: "Store", methods: ["load", "create", "size", "#secret"] },
    { name: "Plain", methods: ["run"] },
  ]);
  assert.deepEqual(s.functions, ["helper", "fetchData", "toJson", "fetchAll", "topLevel"]);
  assert.deepEqual(extractSymbols("lib/a.js", "module.exports = function () {};\nfunction a() {}\n")!.functions, ["a"]);
});

test("non-code files have no symbols", () => {
  assert.equal(extractSymbols("README.md", "def x(): not code"), null);
  assert.equal(extractSymbols("data.json", "{}"), null);
});

// ---- Description validation ----

test("a description naming an identifier that is not in the source is rejected", () => {
  assert.equal(unknownIdentifier("Defines InsightAgent with a chat() entry point.", PY), "chat");
  assert.equal(unknownIdentifier("Wraps `InsightAgent.chat` for the UI.", PY), "chat");
  assert.equal(unknownIdentifier("Exposes agent.respond for callers.", PY), "respond");
});

test("descriptions with only real names, file paths or plain prose are accepted", () => {
  assert.equal(unknownIdentifier("Defines InsightAgent; ask() answers and _remember() stores history.", PY), null);
  assert.equal(unknownIdentifier("Agent module used by app/main.py and `app/db.py`, e.g. for questions.", PY, "app/agent.py"), null);
  assert.equal(unknownIdentifier("An analytics assistant that answers questions about datasets.", PY), null);
});

// ---- Placeholders ----

function toolTurn(id: string, name: string, args: Record<string, unknown>, content: string): Message[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id, name, args }] },
    { role: "tool", toolCallId: id, name, content },
  ];
}

function spyDescriber(reply: (items: DescribeItem[]) => Record<string, string>) {
  const calls: DescribeItem[][] = [];
  const describe: Describer = async (items) => (calls.push(items), reply(items));
  return { calls, describe };
}

test("the placeholder keeps extracted symbols even when the model description is rejected", async () => {
  const code = PY + "\n# padding\n".repeat(200); // > MIN_ELIDE_CHARS
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    ...toolTurn("a", "read_file", { path: "app/agent.py" }, code),
    ...toolTurn("b", "read_file", { path: "app/other.py" }, "x".repeat(2_000)),
  ];
  const store = new ContextStore();
  store.record("a", "read_file", { path: "app/agent.py" }, code);
  const spy = spyDescriber(() => ({ a: "Defines InsightAgent whose chat() method answers questions." }));

  const r = await elideToolResults(messages, { budgetTokens: 0, store, describe: spy.describe });
  const placeholder = r.messages[3]!.content!;
  assert.match(placeholder, /^\[Elided: read_file app\/agent\.py \([\d,]+ chars\)\. Symbols: class InsightAgent: ask, stream, _inputs, _remember; class Store: load; functions: main, build_app\. This is a lossy summary/);
  assert.doesNotMatch(placeholder, /Description:|chat\(\)/);
  assert.deepEqual(r.rejected.map((x) => x.token), ["chat"]);
  assert.equal(store.descriptions.get("a"), "", "rejection is cached so it is not regenerated");
});

test("a valid description is placed next to the symbols", async () => {
  const code = PY + "\n# padding\n".repeat(200);
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    ...toolTurn("a", "read_file", { path: "app/agent.py" }, code),
    ...toolTurn("b", "run_shell", { command: "echo hi" }, "hi"),
  ];
  const store = new ContextStore();
  store.record("a", "read_file", { path: "app/agent.py" }, code);
  const spy = spyDescriber(() => ({ a: "Analytics agent that answers questions with a rolling memory." }));
  const r = await elideToolResults(messages, { budgetTokens: 0, store, describe: spy.describe });
  assert.match(
    r.messages[3]!.content!,
    /Symbols: class InsightAgent: .*\. Description: Analytics agent that answers questions with a rolling memory\. This is a lossy summary/,
  );
});

// ---- Listings ----

test("listings in common formats are detected and parsed into relative paths", () => {
  const cases: [string, string, string][] = [
    ["git ls-files", "README.md\napp/agent.py\napp/db.py\ntests/test_agent.py\n", "./: README.md; app/: agent.py, db.py; tests/: test_agent.py"],
    ["dir /s /b", "C:\\work\\proj\\app\nC:\\work\\proj\\app\\agent.py\nC:\\work\\proj\\app\\db.py\nC:\\work\\proj\\tests\nC:\\work\\proj\\tests\\test_db.py\n", "./: app/, tests/; app/: agent.py, db.py; tests/: test_db.py"],
    [
      "dir",
      " Volume in drive C has no label.\n Directory of C:\\work\\proj\n\n09/28/2026  10:00 AM    <DIR>          .\n09/28/2026  10:00 AM    <DIR>          app\n09/28/2026  10:00 AM             1,234 README.md\n               1 File(s)          1,234 bytes\n",
      "./: app/, README.md",
    ],
    ["tree", ".\n├── app\n│   ├── agent.py\n│   └── db.py\n└── tests\n    └── test_db.py\n", "./: app/, tests/; app/: agent.py, db.py; tests/: test_db.py"],
    ["find . -type f", ".\n./app/agent.py\n./app/db.py\n./tests/test_db.py\n", "app/: agent.py, db.py; tests/: test_db.py"],
    ["ls -R", ".:\napp\ntests\n\n./app:\nagent.py\ndb.py\n", "./: app/, tests; app/: agent.py, db.py"],
  ];
  for (const [command, output, expected] of cases) {
    assert.ok(isListing("run_shell", { command }, output), `${command} detected`);
    assert.equal(compressListing(parseListing(output)), expected, command);
  }
  // Content-based detection without a listing command.
  assert.ok(isListing("run_shell", { command: "cat files.txt" }, "a/b.py\na/c.py\nd/e.ts\nf.md\ng/h.json\n"));
  assert.ok(!isListing("read_file", { path: "notes.md" }, "First line of prose.\nSecond line here.\nThird.\nFourth line.\nFifth."));
});

test("compressed listings are truncated only when very large, and say how many paths were omitted", () => {
  const paths = Array.from({ length: 2_000 }, (_, i) => `pkg${i % 50}/module_${i}.py`);
  const out = compressListing(paths, 3_000);
  assert.ok(out.length < 3_100);
  const shown = (out.match(/module_\d+\.py/g) ?? []).length;
  assert.match(out, new RegExp(`\\(\\+${2_000 - shown} more paths omitted\\)$`));
});

test("listing results are preserved as grouped paths and never sent to the describer", async () => {
  // A realistic listing: many files in a few directories, so grouping compresses it.
  const files = Array.from({ length: 80 }, (_, i) => `src/module_${i % 4}/file_${i}.py`).join("\n");
  assert.ok(files.length > MIN_ELIDE_CHARS);
  const code = "x".repeat(3_000);
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    ...toolTurn("ls", "run_shell", { command: "git ls-files" }, files),
    ...toolTurn("rd", "read_file", { path: "notes.txt" }, code),
    ...toolTurn("now", "run_shell", { command: "echo hi" }, "hi"),
  ];
  const store = new ContextStore();
  store.record("ls", "run_shell", { command: "git ls-files" }, files);
  store.record("rd", "read_file", { path: "notes.txt" }, code);
  const spy = spyDescriber((items) => Object.fromEntries(items.map((i) => [i.id, "A notes file."])));

  const r = await elideToolResults(messages, { budgetTokens: 0, store, describe: spy.describe });
  assert.deepEqual(spy.calls.flat().map((i) => i.id), ["rd"], "only the non-listing result is described");
  const listing = r.messages[3]!.content!;
  assert.match(listing, /^\[Elided: run_shell git ls-files \([\d,]+ chars\)\. Paths \(80\), grouped by directory: src\/module_0\/: file_0\.py, file_4\.py, /);
  for (let i = 0; i < 80; i++) assert.ok(listing.includes(`file_${i}.py`), `file_${i}.py kept`);
  assert.ok(listing.length < files.length, "grouping made it shorter");
  assert.doesNotMatch(listing, /Description:/);
});

test("results shorter than MIN_ELIDE_CHARS (1,500) are never elided", async () => {
  const short = Array.from({ length: 20 }, (_, i) => `app/f${i}.py`).join("\n"); // a small listing
  assert.ok(short.length < MIN_ELIDE_CHARS);
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    ...toolTurn("ls", "run_shell", { command: "git ls-files" }, short),
    ...toolTurn("x", "read_file", { path: "b.txt" }, "y".repeat(1_400)),
    ...toolTurn("now", "run_shell", { command: "echo" }, "z"),
  ];
  const r = await elideToolResults(messages, { budgetTokens: 0 });
  assert.equal(r.elided, 0);
});

// ---- Describer: full content and batching ----

test("the describer sees the full middle of a file and splits large batches instead of cutting more", async () => {
  const requests: string[] = [];
  const client: LLMClient = {
    async chat(messages) {
      requests.push(messages.at(-1)!.content!);
      const ids = [...messages.at(-1)!.content!.matchAll(/### id: (\w+)/g)].map((m) => m[1]!);
      return { text: JSON.stringify(Object.fromEntries(ids.map((id) => [id, "ok"]))), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, raw: null };
    },
  };
  const describe = makeDescriber(client, () => {});

  // A 6,268-char file whose only definition is in the middle.
  const mid = "p".repeat(3_000) + "\nclass InsightAgent:\n    def ask(self): pass\n" + "q".repeat(3_224);
  await describe([{ id: "f", tool: "read_file", label: "app/agent.py", content: mid }]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.includes("def ask(self)"), "middle of the file is sent");

  // 5 results of 20k chars: each fitted to ~12k (head+tail), batches split at 48k of content,
  // every item is still described, and no item is cut below DESCRIBE_MAX_CHARS.
  requests.length = 0;
  const big = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, tool: "read_file", label: `f${i}`, content: `${i}`.repeat(20_000) }));
  const batches = batchItems(big);
  assert.ok(batches.length > 1, "split into several calls");
  assert.deepEqual(batches.flat().map((b) => b.id), ["b0", "b1", "b2", "b3", "b4"]);
  const out = await describe(big);
  assert.equal(requests.length, batches.length);
  assert.deepEqual(Object.keys(out).sort(), ["b0", "b1", "b2", "b3", "b4"]);
  for (const [i, r] of requests.entries()) {
    const perItem = r.split("### id:").slice(1);
    assert.equal(perItem.length, batches[i]!.length);
    for (const item of perItem) assert.ok(item.length > DESCRIBE_MAX_CHARS, "each item keeps ~12k chars");
    assert.ok(r.length <= 48_000 + perItem.length * 200, "batch stays within the limit");
  }
});

// ---- Nudges ----

const reply = (text: string | null, toolCalls: LLMResponse["toolCalls"]): LLMResponse => ({
  text,
  toolCalls,
  usage: { inputTokens: 0, outputTokens: 0 },
  raw: null,
});

/** Runs the agent with a scripted client; returns the last message content seen at each request. */
async function scripted(dir: string, script: (n: number) => LLMResponse) {
  const seen: string[] = [];
  const client: LLMClient = {
    async chat(messages, tools) {
      if (tools.length === 0) return reply("{}", []);
      const n = messages.filter((m) => m.role === "assistant").length;
      if (n > 0) seen.push(messages.at(-1)!.content ?? "");
      return script(n);
    },
  };
  const result = await runAgent({ task: "x", cwd: dir, client, quiet: true, contextLimit: 1e9 });
  return { seen, result };
}

test("the note-taking nudge fires after 3 silent tool steps and respects the cooldown", async () => {
  const dir = sandbox();
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}`);
  const read = (i: number) => [{ id: `r${i}`, name: "read_file", args: { path: `f${i}.txt` } }];
  // Steps 1-7 read silently, step 8 answers.
  const { seen, result } = await scripted(dir, (n) => (n < 7 ? reply(null, read(n)) : reply("done", [])));

  const nudged = seen.map((s) => s.endsWith(NOTE_NUDGE));
  // Results of steps 3 and 6 carry the reminder (3 silent steps, then a 3-step cooldown).
  assert.deepEqual(nudged, [false, false, true, false, false, true, false]);
  assert.equal(result.nudges.notes, 2);
});

test("writing notes resets the silent-step counter", async () => {
  const dir = sandbox();
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}`);
  const read = (i: number) => [{ id: `r${i}`, name: "read_file", args: { path: `f${i}.txt` } }];
  // Silent, silent, NOTES, silent, silent, then answer: never 3 silent in a row.
  const { seen, result } = await scripted(dir, (n) =>
    n < 5 ? reply(n === 2 ? "f0-f2: config helpers." : null, read(n)) : reply("done", []),
  );
  assert.ok(seen.every((s) => !s.endsWith(NOTE_NUDGE)));
  assert.equal(result.nudges.notes, 0);
});

test("the missing-file hint appears on the first failure", async () => {
  const dir = sandbox();
  const { seen, result } = await scripted(dir, (n) =>
    n === 0 ? reply(null, [{ id: "m", name: "read_file", args: { path: "app/utils.py" } }]) : reply("done", []),
  );
  assert.match(seen[0]!, /^Error: ENOENT/);
  assert.ok(seen[0]!.endsWith(MISSING_FILE_HINT));
  assert.match(seen[0]!, /This file does not exist\. Don't guess paths; list the project files/);
  assert.equal(result.missingFileReads, 1);
  assert.equal(result.nudges.missingFile, 1);
});
