import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/llm/types.js";
import {
  compact,
  elideToolResults,
  ELIDED_PREFIX,
  summarizeOlder,
  SUMMARY_PREFIX,
  type Summarizer,
} from "../src/context/compact.js";
import { ContextTracker, estimateTokens } from "../src/context/tokens.js";
import { splitTurns, validatePairing } from "../src/context/turns.js";

const SYSTEM: Message = { role: "system", content: "system prompt" };
const TASK: Message = { role: "user", content: "the original task" };
const big = (tag: string) => `${tag}:` + "x".repeat(5_000); // ~1,252 tokens each

/** One turn group: an assistant message (with optional notes) plus a tool result for each call. */
function group(turn: number, calls = 1, note?: string): Message[] {
  const ids = Array.from({ length: calls }, (_, i) => `t${turn}c${i}`);
  return [
    {
      role: "assistant",
      content: note ?? `turn ${turn}`,
      toolCalls: ids.map((id) => ({ id, name: "read_file", args: { path: `${id}.txt` } })),
    },
    ...ids.map((id): Message => ({ role: "tool", toolCallId: id, name: "read_file", content: big(id) })),
  ];
}

/** system + task + `turns` groups; even turns make 2 parallel calls. */
function conversation(turns: number, note?: (t: number) => string): Message[] {
  const msgs: Message[] = [SYSTEM, TASK];
  for (let t = 1; t <= turns; t++) msgs.push(...group(t, t % 2 === 0 ? 2 : 1, note?.(t)));
  return msgs;
}

/** Tool results whose content is still the original. */
const fullIds = (msgs: Message[]) =>
  msgs.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool" && !m.content.startsWith(ELIDED_PREFIX)).map((m) => m.toolCallId);

test("validatePairing accepts valid conversations and rejects broken ones", () => {
  const msgs = conversation(5);
  assert.equal(validatePairing(msgs), null);
  const orphan = msgs.filter((m) => !(m.role === "tool" && m.toolCallId === "t2c1"));
  assert.match(validatePairing(orphan)!, /t2c1/);
  const stray = [...msgs.slice(0, 2), ...msgs.slice(3)]; // drop turn 1's assistant message
  assert.match(validatePairing(stray)!, /no matching tool call/);
});

test("Level 1 keeps every tool call/result pair and never adds or removes messages", async () => {
  const msgs = conversation(6);
  const { messages, elided } = await elideToolResults(msgs, { budgetTokens: 5_800 });
  assert.equal(validatePairing(messages), null);
  assert.equal(messages.length, msgs.length);
  messages.forEach((m, i) => {
    const orig = msgs[i]!;
    assert.equal(m.role, orig.role);
    if (m.role === "tool" && orig.role === "tool") assert.equal(m.toolCallId, orig.toolCallId);
  });
  // Each result is ~1,252 tokens (5,005 chars / 4). Kept by budget 5,800: t6c0, t6c1 (unseen), t5c0, t4c1 = ~5,008 tokens. Elided: t4c0, t3c0, t2c0, t2c1, t1c0.
  assert.equal(elided, 5);
});

test("Level 1 keeps the newest results within budget and elides everything older", async () => {
  const msgs = conversation(6);
  const { messages } = await elideToolResults(msgs, { budgetTokens: 5_800 });
  assert.deepEqual(fullIds(messages), ["t4c1", "t5c0", "t6c0", "t6c1"]);
  for (const m of messages) {
    if (m.role === "tool" && !fullIds(messages).includes(m.toolCallId)) {
      assert.match(m.content, /^\[Elided: read_file \(5,00\d chars\)\. This is a lossy summary/);
    }
  }
});

test("Level 1 is idempotent and does not touch short results", async () => {
  const msgs = conversation(5);
  const once = (await elideToolResults(msgs, { budgetTokens: 3_000 })).messages;
  const twice = await elideToolResults(once, { budgetTokens: 3_000 });
  assert.equal(twice.elided, 0);
  assert.deepEqual(twice.messages, once);

  const short: Message[] = [SYSTEM, TASK];
  for (let t = 1; t <= 5; t++) {
    short.push(
      { role: "assistant", content: null, toolCalls: [{ id: `s${t}`, name: "run_shell", args: {} }] },
      { role: "tool", toolCallId: `s${t}`, name: "run_shell", content: "ok" },
    );
  }
  assert.equal((await elideToolResults(short, { budgetTokens: 0 })).elided, 0);
});

test("system prompt and original task are always kept", async () => {
  const summarize: Summarizer = async () => "summary";
  const msgs = conversation(8);
  const l1 = (await elideToolResults(msgs, { budgetTokens: 0 })).messages;
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

  // Every summary ends with a "Remaining work" section (the harness appends its list there).
  assert.deepEqual(result.messages, [
    SYSTEM,
    TASK,
    { role: "user", content: `${SUMMARY_PREFIX}\nSUMMARY TEXT\n\nRemaining work:` },
    ...recent,
  ]);
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
  // Threshold budget sits between the Level 1 result and the current size.
  const r = await compact(msgs, { currentTokens: current, limit: current, threshold: 0.9, summarize });
  assert.deepEqual(r.events.map((e) => e.level), [1]);
  assert.equal(called, false);
  assert.ok(r.tokens < current);
  assert.equal(validatePairing(r.messages), null);
});

// Old turns carry ~1,500-char notes, so the span stays above Level 2's 1,000-token minimum after Level 1.
const withNotes = (turns: number) => conversation(turns, (t) => `notes for turn ${t}: ` + "n".repeat(1_500));

test("compact escalates to Level 2 when Level 1 is not enough", async () => {
  const msgs = withNotes(8);
  const summarize: Summarizer = async () => "short summary";
  const current = estimateTokens(msgs);
  const r = await compact(msgs, { currentTokens: current, limit: 100, threshold: 0.7, summarize });
  assert.deepEqual(r.events.map((e) => e.level), [1, 2]);
  assert.equal(r.level2.status, "accepted");
  assert.equal(validatePairing(r.messages), null);
  assert.deepEqual(r.messages.slice(0, 2), [SYSTEM, TASK]);
  // The last 3 turn groups are kept as messages (Level 1 may have elided their older results).
  const recentShape = (ms: Message[]) => splitTurns(ms, 3).recent.map((m) => (m.role === "tool" ? m.toolCallId : m.role));
  assert.deepEqual(recentShape(r.messages), recentShape(msgs));
  assert.deepEqual(r.messages.at(-1), msgs.at(-1), "the newest result is untouched");
  for (const e of r.events) assert.ok(e.afterTokens < e.beforeTokens);
});

test("compact keeps the Level 1 result if the summarizer fails", async () => {
  const msgs = withNotes(8);
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
