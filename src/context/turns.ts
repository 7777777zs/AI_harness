import type { Message } from "../llm/types.js";

/**
 * Message layout maintained by the agent:
 *   [0] system, [1] original user task, [2]? summary (after a Level 2 compaction),
 *   then turn groups: an assistant message followed by one tool message per tool call.
 */
export interface TurnSplit {
  /** System prompt and original task. Never modified. */
  pinned: Message[];
  /** Everything older than the recent turns (old summary + complete turn groups). */
  middle: Message[];
  /** The last `keepTurns` turn groups. Never modified. */
  recent: Message[];
}

export const PINNED_COUNT = 2;

/**
 * Split at a turn-group boundary, i.e. right before an assistant message. Since all
 * tool results of a turn directly follow their assistant message, a cut there can
 * never separate a tool call from its result.
 */
export function splitTurns(messages: Message[], keepTurns: number): TurnSplit {
  const starts: number[] = [];
  for (let i = PINNED_COUNT; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") starts.push(i);
  }
  const cut =
    starts.length > keepTurns ? starts[starts.length - keepTurns]! : (starts[0] ?? messages.length);
  return {
    pinned: messages.slice(0, PINNED_COUNT),
    middle: messages.slice(PINNED_COUNT, cut),
    recent: messages.slice(cut),
  };
}

/**
 * Check that every tool call has exactly one matching tool result before the next
 * non-tool message, and every tool result answers a call. Returns an error
 * description, or null if the pairing is valid.
 */
export function validatePairing(messages: Message[]): string | null {
  let pending = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === "tool") {
      if (!pending.delete(m.toolCallId)) return `message ${i}: tool result ${m.toolCallId} has no matching tool call`;
      continue;
    }
    if (pending.size > 0) return `message ${i}: tool call(s) ${[...pending].join(", ")} have no result`;
    if (m.role === "assistant") pending = new Set(m.toolCalls.map((c) => c.id));
  }
  if (pending.size > 0) return `end: tool call(s) ${[...pending].join(", ")} have no result`;
  return null;
}
