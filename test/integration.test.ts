// Integration of the Phase 3 tools with context management: list_dir/glob feed the known-files
// list, offset/limit reads count as partial, symbols are extracted from line-numbered output,
// placeholder labels for glob/grep. Uses the REAL tool outputs (hand-written listing strings once
// hid a parsing bug). Mocked LLM, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import type { ToolContext } from "../src/types.js";
import { elideToolResults } from "../src/context/compact.js";
import { Coverage } from "../src/context/coverage.js";
import { isListing, parseListing } from "../src/context/listing.js";
import { ContextStore } from "../src/context/store.js";
import { listDir } from "../src/tools/listDir.js";
import { glob } from "../src/tools/glob.js";
import { readFile } from "../src/tools/readFile.js";
import { runAgent } from "../src/agent.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const PY = `"""Agent module."""\n\nclass InsightAgent:\n    def ask(self, q):\n        return q\n\n    def _remember(self, q, a):\n        pass\n\n\ndef build():\n    pass\n`;

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-int-"));
  created.push(dir);
  const files: Record<string, string> = {
    "README.md": "# demo\n",
    "app/agent.py": PY + "# padding\n".repeat(200),
    "app/db.py": "def get_conn():\n    pass\n",
    "tests/test_agent.py": "def test_ask():\n    pass\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
  };
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}
const ctx = (cwd: string): ToolContext => ({ cwd, confirm: async () => true });

test("list_dir output feeds the known-files list (sizes, directories and footers handled)", async () => {
  const dir = project();
  const out = await listDir.execute({ path: ".", depth: 3 }, ctx(dir));
  assert.match(out, /app\/agent\.py \([\d.]+ KB\)/, "real list_dir output has size suffixes");
  assert.ok(isListing("list_dir", { path: "." }, out));
  assert.deepEqual(
    parseListing(out).filter((p) => !p.endsWith("/")).sort(),
    ["README.md", "app/agent.py", "app/db.py", "tests/test_agent.py"],
  );
  const cov = new Coverage(dir);
  assert.equal(cov.addListing("list_dir", { path: "." }, out), 4);
  assert.ok(![...cov.known].some((p) => p.includes("node_modules")));
});

test("glob output feeds the known-files list; 'No files match' adds nothing", async () => {
  const dir = project();
  const cov = new Coverage(dir);
  const out = await glob.execute({ pattern: "**/*.py" }, ctx(dir));
  assert.equal(cov.addListing("glob", { pattern: "**/*.py" }, out), 3);
  const none = await glob.execute({ pattern: "**/*.rs" }, ctx(dir));
  assert.match(none, /^No files match/);
  assert.equal(cov.addListing("glob", { pattern: "**/*.rs" }, none), 0);
});

test("symbols are extracted from line-numbered read_file output; the label shows the range", async () => {
  const dir = project();
  // A range large enough (> MIN_ELIDE_CHARS) to be elided.
  const args = { path: "app/agent.py", offset: 1, limit: 200 };
  const out = await readFile.execute(args, ctx(dir));
  assert.match(out, /^\s+1\t"""Agent module\."""/, "real offset/limit output is numbered");
  const store = new ContextStore();
  store.record("r", "read_file", args, out);
  const msgs: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    { role: "assistant", content: null, toolCalls: [{ id: "r", name: "read_file", args }] },
    { role: "tool", toolCallId: "r", name: "read_file", content: out },
    { role: "assistant", content: null, toolCalls: [{ id: "z", name: "read_file", args: { path: "README.md" } }] },
    { role: "tool", toolCallId: "z", name: "read_file", content: "# demo\n" },
  ];
  const r = await elideToolResults(msgs, { budgetTokens: 0, store });
  assert.match(
    r.messages[3]!.content!,
    /^\[Elided: read_file app\/agent\.py \(lines 1-200\) \([\d,]+ chars\)\. Symbols: class InsightAgent: ask, _remember; functions: build\./,
  );
});

test("placeholder labels fall back to the pattern for glob and grep", () => {
  const store = new ContextStore();
  store.record("g", "glob", { pattern: "**/*.py" }, "a.py");
  store.record("s", "grep", { pattern: "def ask", path: "app" }, "app/agent.py:4: def ask");
  store.record("f", "read_file", { path: "app/db.py" }, "x");
  assert.equal(store.label("g"), "**/*.py");
  assert.equal(store.label("s"), "def ask in app");
  assert.equal(store.label("f"), "app/db.py");
});

test("through the agent: list_dir populates coverage and an offset/limit read counts as partial", async () => {
  const dir = project();
  let n = 0;
  const statuses: string[] = [];
  const reply = (toolCalls: LLMResponse["toolCalls"], text: string | null = null): LLMResponse => ({
    text,
    toolCalls,
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: null,
  });
  const client: LLMClient = {
    async chat(messages, tools) {
      if (tools.length === 0) return reply([], "{}");
      const last = messages.at(-1)!;
      if (last.role === "user" && last.content?.startsWith("[Harness status")) statuses.push(last.content);
      n++;
      if (n === 1) return reply([{ id: "l", name: "list_dir", args: { path: "." } }]);
      if (n === 2) return reply([{ id: "r", name: "read_file", args: { path: "app/agent.py", offset: 1, limit: 5 } }]);
      return reply([], "done");
    },
  };
  const result = await runAgent({ task: "Summarize each file", cwd: dir, client, quiet: true, coverageCheck: false });
  assert.equal(result.coverage.known, 4);
  assert.match(statuses.at(-1)!, /Read: 1 \(1 partially\) \/ Not yet read: 3/);
});
