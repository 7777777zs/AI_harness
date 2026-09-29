// Retries for transient API failures (rate limits, server errors, connection failures).
// Provider-agnostic: it only understands LLMApiError, which adapters throw.
import { LLMApiError, type LLMClient } from "./types.js";

/** Retries after the first attempt (delays 1s, 2s, 4s, 8s, 16s with the default base). */
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BASE_DELAY_MS = 1_000;

export interface RetryInfo {
  /** 1 for the first retry. */
  retry: number;
  maxRetries: number;
  delayMs: number;
  /** "retry-after" when the provider said how long to wait, else "backoff". */
  reason: "retry-after" | "backoff";
  status: number | undefined;
  message: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; returns [0, 1). */
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

/** Exponential backoff with ±25% jitter: base × 2^(retry−1) × [0.75, 1.25). */
export function backoffDelay(retry: number, baseDelayMs = DEFAULT_BASE_DELAY_MS, random: () => number = Math.random): number {
  return Math.round(baseDelayMs * 2 ** (retry - 1) * (0.75 + 0.5 * random()));
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a client so retryable LLMApiErrors (429, 5xx, connection failures) are retried, honoring
 * the provider's retry-after when given, otherwise with exponential backoff and jitter. Other
 * errors (non-429 4xx, context length, bugs) are thrown immediately. After the last retry it
 * throws a non-retryable LLMApiError saying how many attempts were made.
 */
export function withRetry(client: LLMClient, opts: RetryOptions = {}): LLMClient {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? realSleep;
  return {
    async chat(messages, tools) {
      for (let retry = 1; ; retry++) {
        try {
          return await client.chat(messages, tools);
        } catch (err) {
          if (!(err instanceof LLMApiError) || !err.retryable) throw err;
          if (retry > maxRetries) {
            throw new LLMApiError(`API call failed after ${retry} attempts; last error: ${err.message}`, {
              status: err.status,
              retryable: false,
            });
          }
          const delayMs = err.retryAfterMs ?? backoffDelay(retry, opts.baseDelayMs, opts.random);
          opts.onRetry?.({
            retry,
            maxRetries,
            delayMs,
            reason: err.retryAfterMs !== undefined ? "retry-after" : "backoff",
            status: err.status,
            message: err.message,
          });
          await sleep(delayMs);
        }
      }
    },
  };
}
