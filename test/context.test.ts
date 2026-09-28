import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/llm/types.js";
import { compact, elideToolResults, summarizeOlder, SUMMARY_PREFIX, type Summarizer } from "../src/context/compact.js";
import { ContextTracker, estimateTokens } from "../src/context/tokens.js";
import { splitTurns, validatePairing } from "../src/context/turns.js";

const SYSTEM: Message = { role: "system", content: "system prompt" };
const TASK: Message = { role: "user", content: "the original task" };
const big = (tag: string) => `${tag}:` + "x".repeat(5_000);

/** One turn group: an assistant message plus a tool result for each call. */
function group(turn: number, calls = 1): Message[] {
  const ids = Array.from({ length: calls }, (_, i) => `t${turn}c${i}`);
  return [
    {
      role: "assistant",
      content: `turn ${turn}`,
      toolCalls: ids.map((id) => ({ id, name: "read_file", args: { path: `${id}.txt` } })),
    },
    ...ids.map((id): Message => ({ role: "tool", toolCallId: id, name: "read_file", content: big(id) })),
  ];
}

/** system + task + `turns` groups; alternating groups make multiple parallel calls. */
function conversation(turns: number): Message[] {
  const msgs: Message[] = [SYSTEM, TASK];
  for (let t = 1; t <= turns; t++) msgs.push(...group(t, t % 2 === 0 ? 2 : 1));
  return msgs;
}

const lastGroups = (msgs: Message[], n: number) => splitTurns(msgs, n).recent;

test("validatePairing accepts valid conversations and rejects broken ones", () => {
  const msgs = conversation(5);
  assert.equal(validatePairing(msgs), null);
  const orphan = msgs.filter((m) => !(m.role === "tool" && m.toolCallId === "t2c1"));
  assert.match(validatePairing(orphan)!, /t2c1/);
  const stray = [...msgs.slice(0, 2), ...msgs.slice(3)]; // drop turn 1's assistant message
  assert.match(validatePairing(stray)!, /no matching tool call/);
});

test("Level 1 keeps every tool call/result pair and never adds or removes messages", () => {
  const msgs = conversation(6);
  const { messages, elided } = elideToolResults(msgs, 3);
  assert.equal(validatePairing(messages), null);
  assert.equal(messages.length, msgs.length);
  messages.forEach((m, i) => {
    const orig = msgs[i]!;
    assert.equal(m.role, orig.role);
    if (m.role === "tool" && orig.role === "tool") assert.equal(m.toolCallId, orig.toolCallId);
  });
  // Turns 1-3 are old: 1 + 2 + 1 tool results.
  assert.equal(elided, 4);
});

test("Level 1 leaves the most recent 3 turns untouched and elides older results", () => {
  const msgs = conversation(6);
  const { messages } = elideToolResults(msgs, 3);
  assert.deepEqual(lastGroups(messages, 3), lastGroups(msgs, 3));
  const old = splitTurns(messages, 3).middle.filter((m) => m.role === "tool");
  assert.ok(old.length > 0);
  for (const m of old) assert.match(m.content, /^\[Tool result elided to save context: read_file, 5,\d{3} chars\]$/);
});

test("Level 1 is idempotent and does not touch short results", () => {
  const msgs = conversation(5);
  const once = elideToolResults(msgs, 3).messages;
  const twice = elideToolResults(once, 3);
  assert.equal(twice.elided, 0);
  assert.deepEqual(twice.messages, once);

  const short: Message[] = [SYSTEM, TASK];
  for (let t = 1; t <= 5; t++) {
    short.push(
      { role: "assistant", content: null, toolCalls: [{ id: `s${t}`, name: "run_shell", args: {} }] },
      { role: "tool", toolCallId: `s${t}`, name: "run_shell", content: "ok" },
    );
  }
  assert.equal(elideToolResults(short, 3).elided, 0);
});

test("system prompt and original task are always kept", async () => {
  const summarize: Summarizer = async () => "summary";
  const msgs = conversation(8);
  const l1 = elideToolResults(msgs, 3).messages;
  assert.deepEqual(l1.slice(0, 2), [SYSTEM, TASK]);

  const l2 = (await summarizeOlder(l1, summarize, 3))!;
  assert.deepEqual(l2.messages.slice(0, 2), [SYSTEM, TASK]);

  // A second Level 2 folds the old summary in and still keeps the pinned messages.
  const more = [...l2.messages, ...group(9), ...group(10)];
  const again = (await summarizeOlder(more, summarize, 3))!;
  assert.deepEqual(again.messages.slice(0, 2), [SYSTEM, TASK]);
  assert.equal(again.messages.filter((m) => m.content?.startsWith(SUMMARY_PREFIX)).length, 1);
});

test("Level 2 removes only complete turn groups and keeps pairing valid", async () => {
  const msgs = conversation(7);
  let received: Message[] = [];
  let receivedTask = "";
  const summarize: Summarizer = async (older, task) => {
    received = older;
    receivedTask = task;
    return "SUMMARY TEXT";
  };
  const result = (await summarizeOlder(msgs, summarize, 3))!;

  const { middle, recent } = splitTurns(msgs, 3);
  assert.deepEqual(received, middle, "summarizer receives exactly the older messages");
  assert.equal(receivedTask, TASK.content);
  assert.equal(received[0]!.role, "assistant", "removed slice starts at a group boundary");
  assert.equal(validatePairing([SYSTEM, TASK, ...received]), null, "removed slice is made of whole groups");

  assert.deepEqual(result.messages, [SYSTEM, TASK, { role: "user", content: `${SUMMARY_PREFIX}\nSUMMARY TEXT` }, ...recent]);
  assert.equal(validatePairing(result.messages), null);
  assert.equal(result.removed, middle.length);
});

test("Level 2 is a no-op when there are no more than 3 turns", async () => {
  let called = false;
  const summarize: Summarizer = async () => ((called = true), "s");
  assert.equal(await summarizeOlder(conversation(3), summarize, 3), null);
  assert.equal(called, false);
});

test("compact does nothing below the threshold", async () => {
  const msgs = conversation(6);
  const r = await compact(msgs, { currentTokens: 100, limit: 1_000, threshold: 0.7 });
  assert.equal(r.messages, msgs);
  assert.deepEqual(r.events, []);
});

test("compact stops after Level 1 when that is enough", async () => {
  const msgs = conversation(6);
  let called = false;
  const summarize: Summarizer = async () => ((called = true), "s");
  const current = estimateTokens(msgs);
  // Budget sits between the Level 1 result and the current size.
  const r = await compact(msgs, { currentTokens: current, limit: current, threshold: 0.9, summarize });
  assert.deepEqual(r.events.map((e) => e.level), [1]);
  assert.equal(called, false);
  assert.ok(r.tokens < current);
  assert.equal(validatePairing(r.messages), null);
});

test("compact escalates to Level 2 when Level 1 is not enough", async () => {
  const msgs = conversation(8);
  const summarize: Summarizer = async () => "short summary";
  const current = estimateTokens(msgs);
  const r = await compact(msgs, { currentTokens: current, limit: 100, threshold: 0.7, summarize });
  assert.deepEqual(r.events.map((e) => e.level), [1, 2]);
  assert.equal(validatePairing(r.messages), null);
  assert.deepEqual(r.messages.slice(0, 2), [SYSTEM, TASK]);
  assert.deepEqual(lastGroups(r.messages, 3), lastGroups(msgs, 3));
  for (const e of r.events) assert.ok(e.afterTokens < e.beforeTokens);
});

test("compact keeps the Level 1 result if the summarizer fails", async () => {
  const msgs = conversation(8);
  const summarize: Summarizer = async () => {
    throw new Error("boom");
  };
  const r = await compact(msgs, { currentTokens: 1e6, limit: 100, threshold: 0.7, summarize });
  assert.deepEqual(r.events.map((e) => e.level), [1]);
  assert.match(r.notes.join(), /boom/);
  assert.equal(validatePairing(r.messages), null);
});

test("ContextTracker uses ground truth plus a heuristic for new messages", () => {
  const msgs = conversation(2);
  const tracker = new ContextTracker();
  assert.equal(tracker.estimate(msgs, []), estimateTokens(msgs), "heuristic before any response");

  tracker.record(5_000, msgs.length);
  assert.equal(tracker.estimate(msgs, []), 5_000);
  const grown = [...msgs, ...group(3)];
  assert.equal(tracker.estimate(grown, []), 5_000 + estimateTokens(group(3)));

  tracker.record(0, grown.length); // provider reported no usage: keep previous base
  assert.equal(tracker.estimate(grown, []), 5_000 + estimateTokens(group(3)));

  tracker.reset(1_000, grown.length);
  assert.equal(tracker.estimate(grown, []), 1_000);
});
