// Retries for transient API failures (rate limits, server errors, connection failures).
// Provider-agnostic: it only understands LLMApiError, which adapters throw.
import { LLMApiError, type LLMClient } from "./types.js";

/** Retries after the first attempt (delays 1s, 2s, 4s, 8s, 16s with the default base). */
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BASE_DELAY_MS = 1_000;
/** No single wait is longer than this, whatever the provider asks for. */
export const MAX_WAIT_MS = 60_000;

export interface RetryInfo {
  /** 1 for the first retry. */
  retry: number;
  maxRetries: number;
  delayMs: number;
  /** Which wait was longer: the provider's retry-after or the exponential backoff. */
  reason: "retry-after" | "backoff";
  /** The wait was cut to MAX_WAIT_MS. */
  capped: boolean;
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
 * Wrap a client so retryable LLMApiErrors (429, 5xx, connection failures) are retried. Each wait
 * is the longer of the provider's retry-after and the exponential backoff (with jitter), capped at
 * MAX_WAIT_MS: under a shared tokens-per-minute limit the provider's hints are a few seconds, and
 * concurrent jobs would use up every retry inside one window. Other errors (non-429 4xx, context
 * length, bugs) are thrown immediately. After the last retry it throws a non-retryable
 * LLMApiError saying how many attempts were made.
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
          const backoff = backoffDelay(retry, opts.baseDelayMs, opts.random);
          const providerWins = err.retryAfterMs !== undefined && err.retryAfterMs >= backoff;
          // The provider's wait gets jitter too (only upward: never shorter than asked), so jobs given
          // the same hint don't retry in lockstep.
          const random = opts.random ?? Math.random;
          const wanted = providerWins ? Math.round(err.retryAfterMs! * (1 + 0.25 * random())) : backoff;
          const delayMs = Math.min(wanted, MAX_WAIT_MS);
          opts.onRetry?.({
            retry,
            maxRetries,
            delayMs,
            reason: providerWins ? "retry-after" : "backoff",
            capped: wanted > MAX_WAIT_MS,
            status: err.status,
            message: err.message,
          });
          await sleep(delayMs);
        }
      }
    },
  };
}
