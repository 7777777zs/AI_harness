// Provider-agnostic types. Nothing in here may depend on a specific LLM SDK.

export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or null if the model sent something unparseable. */
  args: Record<string, unknown> | null;
  /** Set by the adapter when `args` could not be parsed. */
  argsError?: string;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Raw provider response, kept only for logging. */
  raw: unknown;
}

export interface LLMClient {
  /** `tools` may be empty, in which case the model cannot call tools. */
  chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}

/** Thrown by adapters when the request exceeds the model's context window. */
export class ContextLengthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextLengthError";
  }
}
