import type { Message, ToolDefinition } from "../llm/types.js";

/** Rough token estimate: characters / 4. No tokenizer dependency. */
export function estimateChars(chars: number): number {
  return Math.ceil(chars / 4);
}

function messageChars(m: Message): number {
  let chars = (m.content ?? "").length;
  if (m.role === "assistant") {
    for (const call of m.toolCalls) chars += call.name.length + JSON.stringify(call.args ?? {}).length;
  }
  return chars;
}

export function estimateTokens(messages: Message[]): number {
  return estimateChars(messages.reduce((sum, m) => sum + messageChars(m), 0));
}

export function estimateToolDefs(tools: ToolDefinition[]): number {
  return tools.length === 0 ? 0 : estimateChars(JSON.stringify(tools).length);
}

/**
 * Tracks the current context size. The latest API response's `inputTokens` is the
 * ground truth; messages appended since that call are estimated with the heuristic.
 * Before the first call (or if the provider reports no usage) it is fully heuristic.
 */
export class ContextTracker {
  private baseTokens = 0;
  private baseCount = 0;
  private hasBase = false;

  estimate(messages: Message[], tools: ToolDefinition[]): number {
    if (!this.hasBase) return estimateTokens(messages) + estimateToolDefs(tools);
    return this.baseTokens + estimateTokens(messages.slice(this.baseCount));
  }

  /** Record ground truth: `inputTokens` covered the first `messageCount` messages. */
  record(inputTokens: number, messageCount: number): void {
    if (inputTokens <= 0) return;
    this.reset(inputTokens, messageCount);
  }

  /** Rebase after compaction: the first `messageCount` messages are now ~`tokens`. */
  reset(tokens: number, messageCount: number): void {
    this.baseTokens = tokens;
    this.baseCount = messageCount;
    this.hasBase = true;
  }
}
