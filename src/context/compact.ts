import type { Message } from "../llm/types.js";
import { estimateChars, estimateTokens } from "./tokens.js";
import { splitTurns, validatePairing } from "./turns.js";

export const KEEP_TURNS = 3;
const ELIDED_PREFIX = "[Tool result elided to save context:";
export const SUMMARY_PREFIX = "[Summary of earlier conversation, generated to save context]";

/** Summarizes older messages; receives the original task for context. */
export type Summarizer = (older: Message[], task: string) => Promise<string>;

export interface CompactionEvent {
  level: 1 | 2;
  beforeTokens: number;
  afterTokens: number;
  detail: string;
  summary?: string;
}

export interface CompactOptions {
  /** Current estimated context size in tokens. */
  currentTokens: number;
  limit: number;
  threshold: number;
  summarize?: Summarizer;
  /** Compact regardless of the threshold (after a context-length error). */
  force?: boolean;
  keepTurns?: number;
}

export interface CompactResult {
  messages: Message[];
  /** Estimated tokens after compaction. */
  tokens: number;
  /** One event per level that changed something. */
  events: CompactionEvent[];
  /** Non-fatal remarks, e.g. why a level could not help. */
  notes: string[];
}

/**
 * Level 1: replace the content of tool results older than the last `keepTurns`
 * turns with a short placeholder. Messages are never added, removed or reordered,
 * so every tool call keeps its matching result.
 */
export function elideToolResults(messages: Message[], keepTurns = KEEP_TURNS) {
  const { pinned, middle, recent } = splitTurns(messages, keepTurns);
  let savedChars = 0;
  let elided = 0;
  const newMiddle = middle.map((m): Message => {
    if (m.role !== "tool" || m.content.startsWith(ELIDED_PREFIX)) return m;
    const placeholder = `${ELIDED_PREFIX} ${m.name}, ${m.content.length.toLocaleString("en-US")} chars]`;
    if (placeholder.length >= m.content.length) return m;
    savedChars += m.content.length - placeholder.length;
    elided++;
    return { ...m, content: placeholder };
  });
  return { messages: [...pinned, ...newMiddle, ...recent], elided, savedTokens: estimateChars(savedChars) };
}

/**
 * Level 2: replace everything between the pinned messages and the last `keepTurns`
 * turn groups with one summary message. The cut is at a turn-group boundary, so only
 * complete groups (assistant message + all its tool results) are removed.
 * Returns null if there is no complete turn group old enough to summarize.
 */
export async function summarizeOlder(messages: Message[], summarize: Summarizer, keepTurns = KEEP_TURNS) {
  const { pinned, middle, recent } = splitTurns(messages, keepTurns);
  if (!middle.some((m) => m.role === "assistant")) return null;
  const task = pinned[1]?.content ?? "";
  const text = await summarize(middle, task);
  const summary: Message = { role: "user", content: `${SUMMARY_PREFIX}\n${text}` };
  return {
    messages: [...pinned, summary, ...recent],
    removed: middle.length,
    summary: text,
    savedTokens: estimateTokens(middle) - estimateTokens([summary]),
  };
}

/** Apply Level 1, then Level 2 if still needed. Pure except for the summarizer call. */
export async function compact(messages: Message[], opts: CompactOptions): Promise<CompactResult> {
  const keepTurns = opts.keepTurns ?? KEEP_TURNS;
  const budget = opts.limit * opts.threshold;
  const result: CompactResult = { messages, tokens: opts.currentTokens, events: [], notes: [] };
  if (!opts.force && opts.currentTokens <= budget) return result;

  const l1 = elideToolResults(messages, keepTurns);
  if (l1.elided > 0) {
    const after = Math.max(0, result.tokens - l1.savedTokens);
    result.events.push({
      level: 1,
      beforeTokens: result.tokens,
      afterTokens: after,
      detail: `elided ${l1.elided} tool result${l1.elided === 1 ? "" : "s"}`,
    });
    result.messages = l1.messages;
    result.tokens = after;
  }

  if (!opts.force && result.tokens <= budget) return result;
  if (!opts.summarize) {
    result.notes.push("no summarizer available for Level 2");
    return result;
  }

  let l2;
  try {
    l2 = await summarizeOlder(result.messages, opts.summarize, keepTurns);
  } catch (err) {
    result.notes.push(`Level 2 summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (!l2) {
    result.notes.push(`nothing older than the last ${keepTurns} turns to summarize`);
    return result;
  }
  const pairingError = validatePairing(l2.messages);
  if (pairingError) {
    result.notes.push(`Level 2 discarded, it would break tool-call pairing: ${pairingError}`);
    return result;
  }
  const after = Math.max(0, result.tokens - l2.savedTokens);
  result.events.push({
    level: 2,
    beforeTokens: result.tokens,
    afterTokens: after,
    detail: `summarized ${l2.removed} message${l2.removed === 1 ? "" : "s"}`,
    summary: l2.summary,
  });
  result.messages = l2.messages;
  result.tokens = after;
  return result;
}
