// Retries for transient API errors: retry-after, backoff, non-retryable 4xx, giving up; the
// OpenAI adapter's error mapping; agent-level behavior; eval outcome classification. No API calls.
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextLengthError, LLMApiError, type LLMClient, type LLMResponse, type Message } from "../src/llm/types.js";
import { backoffDelay, withRetry } from "../src/llm/retry.js";
import { OpenAIClient, parseRetryAfter } from "../src/llm/openai.js";
import { runAgent } from "../src/agent.js";
import { estimateTokens, estimateToolDefs } from "../src/context/tokens.js";
import { classifyOutcome } from "../evals/options.js";

const ok: LLMResponse = { text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, raw: null };
const messages: Message[] = [{ role: "user", content: "hi" }];

/** A client that throws the given errors in order, then answers. */
function flaky(errors: unknown[]) {
  let calls = 0;
  const client: LLMClient = {
    async chat() {
      calls++;
      if (errors.length) throw errors.shift();
      return ok;
    },
  };
  return { client, calls: () => calls };
}
const api = (status: number | undefined, retryAfterMs?: number) =>
  new LLMApiError(`${status ?? "connection error"}: boom`, {
    status,
    retryable: status === undefined || status === 429 || status >= 500,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });

// ---- withRetry ----

test("retry-after from the provider is honored", async () => {
  const sleeps: number[] = [];
  const reasons: string[] = [];
  const { client, calls } = flaky([api(429, 1_234)]);
  const r = await withRetry(client, { sleep: async (ms) => void sleeps.push(ms), onRetry: (i) => void reasons.push(i.reason) }).chat(messages, []);
  assert.equal(r.text, "ok");
  assert.equal(calls(), 2);
  assert.deepEqual(sleeps, [1_234]);
  assert.deepEqual(reasons, ["retry-after"]);
});

test("without retry-after: exponential backoff 1s, 2s, 4s, 8s, 16s, then give up with a clear error", async () => {
  const sleeps: number[] = [];
  const { client, calls } = flaky(Array.from({ length: 10 }, () => api(503)));
  await assert.rejects(
    withRetry(client, { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 }).chat(messages, []),
    (err: unknown) =>
      err instanceof LLMApiError &&
      !err.retryable &&
      err.status === 503 &&
      /^API call failed after 6 attempts; last error: 503: boom$/.test(err.message),
  );
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(calls(), 6, "1 attempt + 5 retries");
});

test("backoff has ±25% jitter", () => {
  assert.equal(backoffDelay(1, 1_000, () => 0), 750);
  assert.equal(backoffDelay(1, 1_000, () => 0.999999), 1_250);
  assert.equal(backoffDelay(3, 1_000, () => 0.5), 4_000);
});

test("5xx and connection errors are retried; the run recovers", async () => {
  const { client, calls } = flaky([api(500), api(502), api(undefined)]);
  assert.equal((await withRetry(client, { sleep: async () => {} }).chat(messages, [])).text, "ok");
  assert.equal(calls(), 4);
});

test("non-retryable errors are thrown immediately: 4xx other than 429, context length, other errors", async () => {
  for (const err of [api(401), api(400), api(404), new ContextLengthError("too long"), new TypeError("bug")]) {
    let slept = false;
    const { client, calls } = flaky([err]);
    await assert.rejects(withRetry(client, { sleep: async () => void (slept = true) }).chat(messages, []), (e) => e === err);
    assert.equal(calls(), 1);
    assert.equal(slept, false);
  }
});

// ---- OpenAI adapter mapping ----

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubFetch(status: number, headers: Record<string, string> = {}) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: `status ${status}`, type: "x", code: null } }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof fetch;
  return () => calls;
}

test("adapter: 429 / 5xx become retryable LLMApiErrors with retry-after; 401 is not retryable; no hidden SDK retries", async () => {
  const cases: [number, Record<string, string>, boolean, number | undefined][] = [
    [429, { "retry-after-ms": "250" }, true, 250],
    [429, { "retry-after": "2" }, true, 2_000],
    [500, {}, true, undefined],
    [503, {}, true, undefined],
    [401, {}, false, undefined],
  ];
  for (const [status, headers, retryable, retryAfterMs] of cases) {
    const calls = stubFetch(status, headers);
    await assert.rejects(new OpenAIClient("sk-test", "m").chat(messages, []), (err: unknown) => {
      assert.ok(err instanceof LLMApiError, `${status}`);
      assert.equal(err.status, status);
      assert.equal(err.retryable, retryable, `${status} retryable`);
      assert.equal(err.retryAfterMs, retryAfterMs, `${status} retry-after`);
      return true;
    });
    assert.equal(calls(), 1, "the SDK itself does not retry (maxRetries: 0)");
  }
});

test("parseRetryAfter: ms, seconds, HTTP date, absent, clamped", () => {
  const h = (x: Record<string, string>) => new Headers(x);
  assert.equal(parseRetryAfter(h({ "retry-after-ms": "1500" })), 1_500);
  assert.equal(parseRetryAfter(h({ "retry-after": "3" })), 3_000);
  const now = Date.parse("2026-09-29T00:00:00Z");
  assert.equal(parseRetryAfter(h({ "retry-after": "Tue, 29 Sep 2026 00:00:05 GMT" }), now), 5_000);
  assert.equal(parseRetryAfter(h({})), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(h({ "retry-after": "9999" })), 120_000, "clamped to 2 minutes");
});

// ---- Agent level ----

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sandbox = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-retry-"));
  created.push(dir);
  for (const [p, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), c);
  return dir;
};
const logOf = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("agent: transient errors are retried and logged; the run finishes normally", async () => {
  const { client } = flaky([api(429, 10), api(503)]);
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, retry: { sleep: async () => {} } });
  assert.equal(result.stopReason, "done");
  const retries = logOf(result.logFile).filter((l) => l.type === "api_retry");
  assert.deepEqual(retries.map((l) => [l.source, l.status, l.retry, l.reason]), [["main", 429, 1, "retry-after"], ["main", 503, 2, "backoff"]]);
});

test("agent: after the last retry the run stops with stopReason error, errorKind api and a clear message", async () => {
  const { client } = flaky(Array.from({ length: 10 }, () => api(429)));
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, retry: { sleep: async () => {} } });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorKind, "api");
  assert.match(result.error!, /^API call failed after 6 attempts; last error: 429/);
});

test("agent: an invalid API key (401) is not retried", async () => {
  const { client, calls } = flaky([api(401)]);
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, retry: { sleep: async () => {} } });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorKind, "api");
  assert.equal(calls(), 1);
  assert.equal(logOf(result.logFile).filter((l) => l.type === "api_retry").length, 0);
});

test("agent: the compaction model's calls are retried too", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`f${i}.py`] = `def f${i}():\n    pass\n` + "# pad\n".repeat(600);
  const dir = sandbox(files);
  const main: LLMClient = {
    async chat(msgs, tools) {
      const u = { inputTokens: estimateTokens(msgs) + estimateToolDefs(tools), outputTokens: 1 };
      const n = msgs.filter((m) => m.role === "assistant").length;
      if (n < 5) return { text: null, toolCalls: [{ id: `r${n}`, name: "read_file", args: { path: `f${n}.py` } }], usage: u, raw: null };
      return { ...ok, usage: u };
    },
  };
  let first = true;
  const compactClient: LLMClient = {
    async chat(msgs) {
      if (first) {
        first = false;
        throw api(503);
      }
      const ids = [...(msgs.at(-1)!.content ?? "").matchAll(/### id: (\w+)/g)].map((m) => m[1]!);
      return { ...ok, text: JSON.stringify(Object.fromEntries(ids.map((id) => [id, "A padded module."]))) };
    },
  };
  const result = await runAgent({ task: "x", cwd: dir, client: main, compactClient, quiet: true, contextLimit: 6_000, retry: { sleep: async () => {} } });
  assert.equal(result.stopReason, "done");
  const retries = logOf(result.logFile).filter((l) => l.type === "api_retry");
  assert.deepEqual(retries.map((l) => [l.source, l.status]), [["compaction", 503]]);
  assert.equal(result.compactionStats.describeFailures, 0, "the retried describe call succeeded");
});

// ---- Eval runner classification ----

test("eval runs that ended on API errors are 'error', not 'fail'", () => {
  assert.equal(classifyOutcome(true, undefined), "pass");
  assert.equal(classifyOutcome(false, "api"), "error");
  assert.equal(classifyOutcome(false, "other"), "fail");
  assert.equal(classifyOutcome(false, "context_length"), "fail");
  assert.equal(classifyOutcome(false, undefined), "fail");
});
