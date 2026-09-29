// Size caps that keep a single turn (or a whole request) from exceeding the context limit.
// Results the model hasn't seen yet can't be elided by compaction, so they are capped here.
import type { Message } from "../llm/types.js";
import { truncate } from "../tools/util.js";

/** No single tool result may exceed this share of the context limit. */
export const RESULT_CAP_FRACTION = 0.25;
/** All tool results of one turn together may not exceed this share of the context limit. */
export const TURN_CAP_FRACTION = 0.5;
/** Results are never shrunk below this many tokens by the per-turn / preflight caps. */
export const MIN_RESULT_TOKENS = 200;
/** Room reserved for the continuation note. */
const NOTE_TOKENS = 40;

export type TokensOf = (text: string) => number;

const RANGED_LINE = /^\s*(\d+)\t/;
const RANGE_FOOTER = /^\[lines (\d+)-(\d+) of (\d+)/;

/**
 * Shrink a tool result to at most `maxTokens` (estimated). read_file output is cut at a line
 * boundary with a note saying where to continue; other output uses head+tail truncation.
 * Returns the content unchanged if it already fits.
 */
export function capResult(
  name: string,
  args: Record<string, unknown> | null | undefined,
  content: string,
  maxTokens: number,
  tokensOf: TokensOf,
): string {
  const tokens = tokensOf(content);
  if (tokens <= maxTokens) return content;
  if (name === "read_file" && !content.startsWith("Error:")) {
    const cut = capReadFile(content, maxTokens, tokensOf);
    if (cut !== null) return cut;
  }
  const maxChars = Math.max(200, Math.floor((content.length * maxTokens) / tokens * 0.95));
  return truncate(content, maxChars);
}

/** Keep the first whole lines of read_file output that fit; null if not even one line fits. */
function capReadFile(content: string, maxTokens: number, tokensOf: TokensOf): string | null {
  let lines = content.split("\n");
  let total: number | null = null;
  const footer = lines.length ? RANGE_FOOTER.exec(lines.at(-1)!) : null;
  if (footer) {
    total = Number(footer[3]);
    lines = lines.slice(0, -1);
  }
  const ranged = lines.length > 0 && RANGED_LINE.test(lines[0]!);
  if (lines.at(-1) === "") lines = lines.slice(0, -1); // trailing newline
  if (total === null) total = ranged ? Number(RANGED_LINE.exec(lines.at(-1)!)?.[1] ?? lines.length) : lines.length;

  const budget = maxTokens - NOTE_TOKENS;
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const t = tokensOf(line) + 1;
    if (used + t > budget) break;
    used += t;
    kept++;
  }
  if (kept === 0) return null;
  const lastLine = ranged ? Number(RANGED_LINE.exec(lines[kept - 1]!)![1]) : kept;
  return (
    `${lines.slice(0, kept).join("\n")}\n` +
    `[Truncated at line ${lastLine} of ${total}. Use read_file with offset=${lastLine + 1} and limit to read more.]`
  );
}

export interface TurnResult {
  name: string;
  args: Record<string, unknown> | null | undefined;
  content: string;
}

/**
 * Per-turn cap: if the results of one turn together exceed `budgetTokens`, shrink the largest
 * results first (never below MIN_RESULT_TOKENS) until they fit. Returns the new contents.
 */
export function capTurn(results: TurnResult[], budgetTokens: number, tokensOf: TokensOf): string[] {
  const contents = results.map((r) => r.content);
  const sizes = contents.map(tokensOf);
  for (let guard = 0; guard < results.length * 4; guard++) {
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total <= budgetTokens) break;
    let largest = -1;
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i]! > MIN_RESULT_TOKENS && (largest === -1 || sizes[i]! > sizes[largest]!)) largest = i;
    }
    if (largest === -1) break; // everything is already at the floor
    const target = Math.max(MIN_RESULT_TOKENS, sizes[largest]! - (total - budgetTokens));
    const next = capResult(results[largest]!.name, results[largest]!.args, contents[largest]!, target, tokensOf);
    const nextSize = tokensOf(next);
    if (nextSize >= sizes[largest]!) break; // could not shrink further
    contents[largest] = next;
    sizes[largest] = nextSize;
  }
  return contents;
}

/**
 * Preflight: shrink the newest tool results (newest first) until `excessTokens` have been
 * saved. Returns the new messages and the tool call ids that were shrunk.
 */
export function shrinkNewest(
  messages: Message[],
  excessTokens: number,
  tokensOf: TokensOf,
): { messages: Message[]; shrunk: string[]; saved: number } {
  const argsById = new Map<string, Record<string, unknown> | null>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls) argsById.set(c.id, c.args);
  const out = [...messages];
  const shrunk: string[] = [];
  let saved = 0;
  for (let i = out.length - 1; i >= 0 && saved < excessTokens; i--) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    const before = tokensOf(m.content);
    if (before <= MIN_RESULT_TOKENS) continue;
    const target = Math.max(MIN_RESULT_TOKENS, before - (excessTokens - saved));
    const content = capResult(m.name, argsById.get(m.toolCallId), m.content, target, tokensOf);
    const after = tokensOf(content);
    if (after >= before) continue;
    out[i] = { ...m, content };
    shrunk.push(m.toolCallId);
    saved += before - after;
  }
  return { messages: out, shrunk, saved };
}
