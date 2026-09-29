import type { Message, ToolDefinition } from "../llm/types.js";

/** Chinese/Japanese/Korean characters (and full-width forms). */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
/**
 * Tokens per CJK character and characters per token for other text. Measured against gpt-4.1's
 * tokenizer (TEST_REPORT.md, Phase 4): Chinese prose ≈ 0.69 tokens/char, code and English ≈ 4
 * chars/token. The per-run calibration ratio corrects the remaining error.
 */
export const CJK_TOKENS_PER_CHAR = 0.7;
export const CHARS_PER_TOKEN = 4;

/** Heuristic token estimate for a string: CJK characters count 0.7 each, other text chars / 4. */
export function estimateText(s: string): number {
  if (!s) return 0;
  const cjk = s.match(CJK)?.length ?? 0;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (s.length - cjk) / CHARS_PER_TOKEN);
}

/** Heuristic for a character count of non-CJK text (used for "chars saved" arithmetic). */
export function estimateChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function messageText(m: Message): string {
  let text = m.content ?? "";
  if (m.role === "assistant") {
    for (const call of m.toolCalls) text += call.name + JSON.stringify(call.args ?? {});
  }
  return text;
}

export function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateText(messageText(m)), 0);
}

export function estimateToolDefs(tools: ToolDefinition[]): number {
  return tools.length === 0 ? 0 : estimateText(JSON.stringify(tools));
}

export const RATIO_MIN = 0.5;
export const RATIO_MAX = 3.0;
/** Weight of each new observation in the smoothed ratio. */
export const RATIO_ALPHA = 0.3;

/**
 * Tracks the current context size. The latest API response's `inputTokens` is the ground
 * truth; messages appended since that call are estimated with the heuristic, scaled by a
 * calibration ratio learned during the run (actual tokens / heuristic estimate, smoothed
 * with an exponential moving average and clamped to [0.5, 3.0]).
 */
export class ContextTracker {
  private baseTokens = 0;
  private baseCount = 0;
  private hasBase = false;
  /** Calibration: actual input tokens / heuristic estimate. 1 until the first response. */
  ratio = 1;
  private observations = 0;

  /** Calibrated estimate of arbitrary text (e.g. a tool result or the status block). */
  tokensOf(text: string): number {
    return Math.ceil(estimateText(text) * this.ratio);
  }

  /** Calibrated estimate of a list of messages. */
  tokensOfMessages(messages: Message[]): number {
    return Math.ceil(estimateTokens(messages) * this.ratio);
  }

  estimate(messages: Message[], tools: ToolDefinition[]): number {
    if (!this.hasBase) return Math.ceil((estimateTokens(messages) + estimateToolDefs(tools)) * this.ratio);
    return this.baseTokens + this.tokensOfMessages(messages.slice(this.baseCount));
  }

  /**
   * Record ground truth: `inputTokens` covered the first `messageCount` messages, and the
   * uncalibrated heuristic for that same request was `heuristicTokens` (if known). Updates the
   * calibration ratio. Returns the observed ratio for this request, or null.
   */
  record(inputTokens: number, messageCount: number, heuristicTokens?: number): number | null {
    if (inputTokens <= 0) return null;
    this.reset(inputTokens, messageCount);
    if (!heuristicTokens || heuristicTokens <= 0) return null;
    const observed = inputTokens / heuristicTokens;
    const next = this.observations === 0 ? observed : this.ratio + RATIO_ALPHA * (observed - this.ratio);
    this.ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, next));
    this.observations++;
    return observed;
  }

  /** Rebase after compaction: the first `messageCount` messages are now ~`tokens`. */
  reset(tokens: number, messageCount: number): void {
    this.baseTokens = tokens;
    this.baseCount = messageCount;
    this.hasBase = true;
  }
}
