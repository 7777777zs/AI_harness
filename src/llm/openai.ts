// OpenAI Chat Completions adapter. All OpenAI-specific formats live here.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ContextLengthError, LLMApiError } from "./types.js";
import type { ContextWindow, LLMClient, LLMResponse, Message, ToolCall, ToolDefinition } from "./types.js";

/** How long to wait for an OpenAI-compatible server to describe the model (Ollama's /api/show). */
const SHOW_TIMEOUT_MS = 3_000;

export class OpenAIClient implements LLMClient {
  private client: OpenAI;

  /** `reasoningEffort` is sent as reasoning_effort, e.g. "none" turns Qwen3's thinking off on Ollama. */
  constructor(apiKey: string, private model: string, private reasoningEffort?: string) {
    // Retries are handled by withRetry (src/llm/retry.ts) so every attempt is logged and bounded.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  /**
   * Only for a custom OPENAI_BASE_URL: if it is an Ollama server, its /api/show gives the model's
   * num_ctx. Any other server (no /api/show, an error, a timeout) means "can't tell".
   */
  async contextWindow(): Promise<ContextWindow | null> {
    if (!process.env.OPENAI_BASE_URL) return null;
    let show: { parameters?: unknown; model_info?: unknown };
    try {
      const res = await fetch(`${new URL(this.client.baseURL).origin}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      show = (await res.json()) as typeof show;
    } catch {
      return null;
    }
    if (typeof show !== "object" || show === null || !("model_info" in show)) return null; // not Ollama
    const numCtx = /^num_ctx\s+(\d+)/m.exec(typeof show.parameters === "string" ? show.parameters : "");
    return numCtx
      ? { tokens: Number(numCtx[1]), note: `num_ctx ${numCtx[1]}` }
      : { tokens: null, note: `${this.model} sets no num_ctx, so its window is Ollama's default, which depends on the Ollama version and the GPU memory` };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        // OpenAI rejects an empty tools array, so omit it entirely.
        ...(tools.length > 0 && { tools: tools.map(toOpenAITool) }),
        ...(this.reasoningEffort && { reasoning_effort: this.reasoningEffort as OpenAI.ReasoningEffort }),
      });
    } catch (err) {
      if (isContextLengthError(err)) throw new ContextLengthError((err as Error).message);
      if (err instanceof OpenAI.APIError) {
        // status is undefined for connection failures (APIConnectionError), which are transient.
        const status = err.status;
        const retryable = status === undefined || status === 429 || status >= 500;
        throw new LLMApiError(`${status ?? "connection error"}: ${err.message}`, {
          status,
          retryable,
          retryAfterMs: parseRetryAfter(err.headers),
        });
      }
      throw err;
    }

    const message = response.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      toolCalls.push({ id: call.id, name: call.function.name, ...parseArgs(call.function.arguments) });
    }

    return {
      text: message?.content ?? null,
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      raw: response,
    };
  }
}

/** Longest wait we accept from a retry-after header. */
const MAX_RETRY_AFTER_MS = 120_000;

/** Milliseconds from `retry-after-ms`, or `retry-after` (seconds or an HTTP date); undefined if absent. */
export function parseRetryAfter(headers: Headers | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms)) return clamp(ms);
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clamp(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : clamp(date - now);
}

function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  return err.code === "context_length_exceeded" || /maximum context length|context.length/i.test(err.message);
}

function toOpenAIMessage(m: Message): ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        // OpenAI requires content when there are no tool calls; an empty reply (I36) has neither.
        content: m.content ?? (m.toolCalls.length > 0 ? null : ""),
        ...(m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function toOpenAITool(t: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function parseArgs(raw: string): Pick<ToolCall, "args" | "argsError"> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { args: null, argsError: `expected a JSON object, got: ${raw}` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (err) {
    return { args: null, argsError: `${(err as Error).message}. Raw arguments: ${raw}` };
  }
}
