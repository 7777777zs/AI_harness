// Compaction fixes: Level 2 on originals, Level 2 rejection/skip, budget-based Level 1 with
// batched cached descriptions, repeated-call notices, head+tail truncation. Mocked LLM, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import {
  compact,
  elideToolResults,
  ELIDED_PREFIX,
  type Describer,
  type DescribeItem,
  type Summarizer,
} from "../src/context/compact.js";
import { ContextStore } from "../src/context/store.js";
import { estimateTokens } from "../src/context/tokens.js";
import { splitTurns, validatePairing } from "../src/context/turns.js";
import { runAgent } from "../src/agent.js";
import { truncate } from "../src/tools/util.js";

const SYSTEM: Message = { role: "system", content: "system prompt" };
const TASK: Message = { role: "user", content: "the original task" };
const original = (id: string, size = 5_000) => `ORIGINAL ${id} ` + "x".repeat(size);

function group(turn: number, opts: { calls?: number; note?: string; size?: number } = {}): Message[] {
  const ids = Array.from({ length: opts.calls ?? 1 }, (_, i) => `t${turn}c${i}`);
  return [
    {
      role: "assistant",
      content: opts.note ?? `turn ${turn}`,
      toolCalls: ids.map((id) => ({ id, name: "read_file", args: { path: `src/${id}.py` } })),
    },
    ...ids.map((id): Message => ({ role: "tool", toolCallId: id, name: "read_file", content: original(id, opts.size) })),
  ];
}

/** A conversation plus a store that has recorded every tool result, as the agent does. */
function setup(turns: number, note?: (t: number) => string) {
  const messages: Message[] = [SYSTEM, TASK];
  for (let t = 1; t <= turns; t++) messages.push(...group(t, { ...(note && { note: note(t) }) }));
  const store = new ContextStore();
  for (const m of messages) {
    if (m.role === "tool") store.record(m.toolCallId, m.name, { path: `src/${m.toolCallId}.py` }, m.content);
  }
  return { messages, store };
}
const withNotes = (t: number) => `notes for turn ${t}: ` + "n".repeat(1_500);
const toolMsgs = (ms: Message[]) => ms.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");

// ---- Level 2 ----

test("Level 2 receives original content, not placeholders, when both levels run in one compaction", async () => {
  const { messages, store } = setup(8, withNotes);
  let received: Message[] = [];
  const summarize: Summarizer = async (older) => ((received = older), "short summary");
  const r = await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, summarize, store });

  assert.deepEqual(r.events.map((e) => e.level), [1, 2], "both levels ran");
  const tools = toolMsgs(received);
  assert.ok(tools.length >= 5);
  for (const m of tools) {
    assert.equal(m.content, store.originals.get(m.toolCallId)!.content, `${m.toolCallId} restored`);
    assert.ok(!m.content.startsWith(ELIDED_PREFIX));
  }
});

test("Level 2 falls back to the Level 1 description when no original is stored", async () => {
  const { messages } = setup(8, withNotes);
  const store = new ContextStore(); // nothing recorded
  store.descriptions.set("t1c0", "Helper module; defines foo().");
  let received: Message[] = [];
  const summarize: Summarizer = async (older) => ((received = older), "short summary");
  await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, summarize, store });
  const t1 = toolMsgs(received).find((m) => m.toolCallId === "t1c0")!;
  assert.match(t1.content, /^\[Elided: read_file \(5,\d{3} chars\)\. Description: Helper module; defines foo\(\)\. This is a lossy summary/);
});

test("a Level 2 summary that does not save 20% of the span is rejected and messages are unchanged", async () => {
  const { messages, store } = setup(8, withNotes);
  const budget = 40;
  const l1 = await elideToolResults(messages, { budgetTokens: budget, store });
  const spanTokens = estimateTokens(splitTurns(l1.messages, 3).middle);

  // A summary worth ~85% of the span: saves only ~15%.
  const summarize: Summarizer = async () => "s".repeat(Math.floor(spanTokens * 4 * 0.85));
  const r = await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, recentBudget: budget, summarize, store });

  assert.equal(r.level2.status, "rejected");
  assert.match(r.level2.reason!, /< 20%/);
  assert.deepEqual(r.events.map((e) => e.level), [1], "no Level 2 event");
  assert.deepEqual(r.messages, l1.messages, "messages are exactly the post-Level-1 messages");
  assert.ok(r.tokens <= 1e6);
});

test("a Level 2 summary that saves enough is accepted and never increases the estimate", async () => {
  const { messages, store } = setup(8, withNotes);
  const summarize: Summarizer = async () => "tiny";
  const r = await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, summarize, store });
  assert.equal(r.level2.status, "accepted");
  const l2 = r.events.find((e) => e.level === 2)!;
  assert.ok(l2.afterTokens < l2.beforeTokens);
});

test("Level 2 is skipped without calling the summarizer when the span is under 1,000 tokens", async () => {
  const { messages, store } = setup(8); // short notes: after Level 1 the span is tiny
  let called = false;
  const summarize: Summarizer = async () => ((called = true), "s");
  const r = await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, summarize, store });
  assert.equal(r.level2.status, "skipped");
  assert.equal(called, false);
  assert.ok(r.level2.spanTokens! < 1_000);
});

// ---- Level 1: budget ----

test("budget-based Level 1 keeps the newest result in full even if it alone exceeds the budget", async () => {
  const messages: Message[] = [SYSTEM, TASK, ...group(1), ...group(2), ...group(3, { size: 40_000 })];
  const { messages: out } = await elideToolResults(messages, { budgetTokens: 100 });
  const tools = toolMsgs(out);
  assert.equal(tools.at(-1)!.content, original("t3c0", 40_000), "newest kept in full");
  assert.ok(tools.slice(0, -1).every((m) => m.content.startsWith(ELIDED_PREFIX)), "older ones elided");
  assert.equal(validatePairing(out), null);
});

test("budget-based Level 1 never elides results the model has not seen yet", async () => {
  // The last turn made 3 parallel reads; together they exceed the budget.
  const messages: Message[] = [SYSTEM, TASK, ...group(1), ...group(2), ...group(3, { calls: 3 })];
  const { messages: out } = await elideToolResults(messages, { budgetTokens: 100 });
  const tools = toolMsgs(out);
  assert.deepEqual(
    tools.filter((m) => !m.content.startsWith(ELIDED_PREFIX)).map((m) => m.toolCallId),
    ["t3c0", "t3c1", "t3c2"],
  );
});

test("budget-based Level 1 keeps the newest result when the model has already answered after it", async () => {
  const messages: Message[] = [SYSTEM, TASK, ...group(1), ...group(2), { role: "assistant", content: "notes", toolCalls: [] }];
  const { messages: out } = await elideToolResults(messages, { budgetTokens: 0 });
  assert.deepEqual(toolMsgs(out).map((m) => m.content.startsWith(ELIDED_PREFIX)), [true, false]);
});

test("budget-based Level 1 elides by budget, newest first", async () => {
  const messages: Message[] = [SYSTEM, TASK, ...group(1), ...group(2), ...group(3), ...group(4), ...group(5)];
  const per = estimateTokens([toolMsgs(messages)[0]!]);
  // Room for the unseen t5 result plus two more.
  const { messages: out } = await elideToolResults(messages, { budgetTokens: per * 3 + 1 });
  assert.deepEqual(toolMsgs(out).map((m) => m.content.startsWith(ELIDED_PREFIX)), [true, true, false, false, false]);
});

// ---- Level 1: descriptions ----

function describerSpy(fail = false) {
  const calls: DescribeItem[][] = [];
  const describe: Describer = async (items) => {
    calls.push(items);
    if (fail) throw new Error("describer offline");
    return Object.fromEntries(items.map((it) => [it.id, `Describes ${it.label}.`]));
  };
  return { calls, describe };
}

test("descriptions are generated in one batched call per compaction", async () => {
  const { messages, store } = setup(6);
  const spy = describerSpy();
  const r = await elideToolResults(messages, { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(r.elided, 5);
  assert.equal(spy.calls.length, 1, "one describer call");
  assert.deepEqual(spy.calls[0]!.map((i) => i.id), ["t5c0", "t4c0", "t3c0", "t2c0", "t1c0"]);
  assert.equal(spy.calls[0]![0]!.content, store.originals.get("t5c0")!.content, "describer sees the original");
  const t1 = toolMsgs(r.messages).find((m) => m.toolCallId === "t1c0")!;
  assert.equal(
    t1.content,
    "[Elided: read_file src/t1c0.py (5,014 chars). Description: Describes src/t1c0.py. " +
      "This is a lossy summary — re-read the file if you need exact code, names, or details.]",
  );
});

test("descriptions are cached across compactions and never generated twice", async () => {
  const { messages, store } = setup(4);
  const spy = describerSpy();
  const first = await elideToolResults(messages, { budgetTokens: 0, store, describe: spy.describe });
  assert.deepEqual(spy.calls[0]!.map((i) => i.id), ["t3c0", "t2c0", "t1c0"]);

  // Two more turns; the next compaction must only describe the newly elided results.
  const more = [...first.messages, ...group(5), ...group(6)];
  for (const m of more) if (m.role === "tool" && !store.originals.has(m.toolCallId)) store.record(m.toolCallId, m.name, { path: `src/${m.toolCallId}.py` }, m.content);
  await elideToolResults(more, { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(spy.calls.length, 2);
  assert.deepEqual(spy.calls[1]!.map((i) => i.id), ["t5c0", "t4c0"], "only new ids");

  // Re-running on un-elided originals of already-described results uses the cache: no call.
  const fresh = setup(4);
  const again = await elideToolResults(fresh.messages, { budgetTokens: 0, store, describe: spy.describe });
  assert.equal(spy.calls.length, 2, "no third call");
  assert.match(toolMsgs(again.messages)[0]!.content, /Description: Describes src\/t1c0\.py\. This is a lossy summary/);
});

test("if the description call fails, Level 1 falls back to the plain placeholder and reports it", async () => {
  const { messages, store } = setup(4);
  const spy = describerSpy(true);
  const r = await compact(messages, { currentTokens: 1e6, limit: 100, threshold: 0.7, recentBudget: 0, store, describe: spy.describe });
  assert.equal(r.describeError, "describer offline");
  for (const m of toolMsgs(r.messages).slice(0, -1)) {
    assert.match(m.content, /^\[Elided: read_file src\/t\dc0\.py \(5,014 chars\)\. This is a lossy summary — re-read the file if you need exact code, names, or details\.\]$/);
  }
  assert.equal(store.descriptions.size, 0, "failures are not cached");
});

// ---- Repeated calls ----

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("the repeated-call notice appears from the 2nd identical call, not on the 1st", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-cmp-"));
  created.push(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
  const seen: string[] = [];
  const read = (id: string, p: string): LLMResponse => ({
    text: null,
    toolCalls: [{ id, name: "read_file", args: { path: p } }],
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: null,
  });
  const client: LLMClient = {
    async chat(messages, tools) {
      if (tools.length === 0) return { text: "{}", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: null };
      const n = messages.filter((m) => m.role === "assistant").length;
      if (n > 0) seen.push(messages.at(-1)!.content ?? "");
      // Same file three ways: normalization must treat them as identical.
      if (n === 0) return read("r1", "a.txt");
      if (n === 1) return read("r2", "./a.txt");
      if (n === 2) return read("r3", "sub/../a.txt");
      return { text: "done", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: null };
    },
  };
  const result = await runAgent({ task: "x", cwd: dir, client, quiet: true });

  assert.equal(seen.length, 3);
  assert.equal(seen[0], "alpha", "1st call: no notice");
  assert.match(seen[1]!, /^alpha\n\nNote: you have called read_file on this path 2 times\. Its earlier result may have been removed/);
  assert.match(seen[2]!, /^alpha\n\nNote: you have called read_file on this path 3 times\./);
  assert.equal(result.repeatedCalls, 2);
  assert.equal(result.nudges.repeat, 2);
  const logged = fs.readFileSync(result.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "repeated_call");
  assert.deepEqual(logged.map((l) => l.count), [2, 3]);
});

// ---- Truncation ----

test("truncation keeps head and tail and reports omitted chars and lines", () => {
  // 2,000 lines of exactly 10 chars ("line00001\n") = 20,000 chars.
  const s = Array.from({ length: 2_000 }, (_, i) => `line${String(i + 1).padStart(5, "0")}\n`).join("");
  const out = truncate(s);
  assert.ok(out.startsWith(s.slice(0, 6_000)), "head kept");
  assert.ok(out.endsWith(s.slice(-2_000)), "tail kept");
  assert.match(out, /\n\[\.\.\. truncated: 12,000 chars \/ 1,200 lines omitted \(2,000 lines total\) \.\.\.\]\n/);
  assert.ok(out.includes("line00600\n") && out.includes("line01801\n") && !out.includes("line00601"));
  assert.equal(truncate("short output"), "short output");
});

test("truncation reports sensible counts for output that is one huge line", () => {
  const out = truncate("y".repeat(50_000));
  assert.match(out, /truncated: 42,000 chars \/ 0 lines omitted \(1 lines total\)/);
});
