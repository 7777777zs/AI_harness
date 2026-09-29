// OpenAI Chat Completions adapter. All OpenAI-specific formats live here.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ContextLengthError, LLMApiError } from "./types.js";
import type { LLMClient, LLMResponse, Message, ToolCall, ToolDefinition } from "./types.js";

export class OpenAIClient implements LLMClient {
  private client: OpenAI;

  constructor(apiKey: string, private model: string) {
    // Retries are handled by withRetry (src/llm/retry.ts) so every attempt is logged and bounded.
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        // OpenAI rejects an empty tools array, so omit it entirely.
        ...(tools.length > 0 && { tools: tools.map(toOpenAITool) }),
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
        content: m.content,
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
