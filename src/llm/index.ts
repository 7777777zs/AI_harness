// The single place that chooses an LLM provider. Adding a provider means a new
// adapter file plus a branch here; agent.ts stays unchanged.
import { OpenAIClient } from "./openai.js";
import type { LLMClient } from "./types.js";

/** Name of each required env var, with a hint shown when it is missing. */
export const REQUIRED_ENV: Record<string, string> = {
  OPENAI_API_KEY: "OPENAI_API_KEY is not set.",
  OPENAI_MODEL: "OPENAI_MODEL is not set (e.g. OPENAI_MODEL=gpt-4.1-mini).",
};

/** Returns the error message for the first missing env var, or null. */
export function missingEnv(): string | null {
  for (const [name, message] of Object.entries(REQUIRED_ENV)) {
    if (!process.env[name]) return message;
  }
  return null;
}

/** A client for `model`, or for OPENAI_MODEL when no model is given (e.g. COMPACT_MODEL unset). */
export function createClientFromEnv(model?: string): LLMClient {
  const missing = missingEnv();
  if (missing) throw new Error(missing);
  return new OpenAIClient(process.env.OPENAI_API_KEY!, model ?? process.env.OPENAI_MODEL!);
}
