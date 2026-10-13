// OpenAI adapter tests with a stubbed global fetch. No real API calls.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { envFileSources } from "../src/config.js";
import { modelFromEnv } from "../src/llm/index.js";
import { OpenAIClient } from "../src/llm/openai.js";
import { ContextLengthError, type Message } from "../src/llm/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const requests: any[] = [];

/** Install a fetch stub that records request bodies and returns `status` + `body`. */
function stubFetch(status: number, body: unknown) {
  requests.length = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const completion = (message: object) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 0,
  model: "test-model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, ...message } }],
  usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
});

const messages: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "task" },
];

test("adapter: invalid JSON tool arguments become argsError instead of throwing", async () => {
  stubFetch(200, completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path": "a.txt"' } }] }));
  const res = await new OpenAIClient("sk-test", "test-model").chat(messages, []);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0]!.args, null);
  assert.match(res.toolCalls[0]!.argsError!, /JSON|Expected|Unexpected/);
  assert.deepEqual(res.usage, { inputTokens: 42, outputTokens: 7 });
});

test("adapter: non-object JSON arguments are rejected", async () => {
  stubFetch(200, completion({ tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "[1,2]" } }] }));
  const res = await new OpenAIClient("sk-test", "test-model").chat(messages, []);
  assert.match(res.toolCalls[0]!.argsError!, /expected a JSON object/);
});

test("adapter: HTTP 400 context_length_exceeded is mapped to ContextLengthError", async () => {
  stubFetch(400, {
    error: {
      message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  });
  await assert.rejects(new OpenAIClient("sk-test", "test-model").chat(messages, []), ContextLengthError);
});

test("adapter: other API errors are not mapped to ContextLengthError", async () => {
  stubFetch(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
  await assert.rejects(new OpenAIClient("sk-test", "test-model").chat(messages, []), (err: Error) => {
    assert.ok(!(err instanceof ContextLengthError));
    assert.match(err.message, /Incorrect API key/);
    return true;
  });
});

test("adapter: empty tools array is omitted from the request; tool messages keep tool_call_id", async () => {
  stubFetch(200, completion({ content: "ok" }));
  const client = new OpenAIClient("sk-test", "test-model");
  await client.chat(
    [
      ...messages,
      { role: "assistant", content: null, toolCalls: [{ id: "call_9", name: "read_file", args: { path: "x" } }] },
      { role: "tool", toolCallId: "call_9", name: "read_file", content: "data" },
    ],
    [],
  );
  const body = requests[0];
  assert.equal("tools" in body, false);
  assert.deepEqual(body.messages[2].tool_calls, [
    { id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
  ]);
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "call_9", content: "data" });
});

// ---- Provider boundary ----

test("agent.ts stays provider-agnostic: nothing OpenAI-specific outside src/llm/", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent.ts"), "utf8");
  assert.doesNotMatch(source, /OPENAI|from "openai"/);
});

test("modelFromEnv: the model under test and where it was set (environment or a .env file)", () => {
  const saved = process.env.OPENAI_MODEL;
  try {
    process.env.OPENAI_MODEL = "model-x";
    envFileSources.delete("OPENAI_MODEL");
    assert.deepEqual(modelFromEnv(), { model: "model-x", source: "env" });
    envFileSources.set("OPENAI_MODEL", "/home/u/.harness/.env");
    assert.deepEqual(modelFromEnv(), { model: "model-x", source: ".env" });
  } finally {
    envFileSources.delete("OPENAI_MODEL");
    if (saved === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = saved;
  }
});

test("adapter: a reasoning effort is sent as reasoning_effort on every request; without one the field is absent", async () => {
  stubFetch(200, completion({ content: "391" }));
  await new OpenAIClient("sk-test", "test-model", "none").chat(messages, []);
  assert.equal(requests[0].reasoning_effort, "none");
  stubFetch(200, completion({ content: "391" }));
  await new OpenAIClient("sk-test", "test-model").chat(messages, []);
  assert.ok(!("reasoning_effort" in requests[0]));
});

test("OPENAI_REASONING_EFFORT reaches the client and is reported by modelFromEnv", async () => {
  const saved = { model: process.env.OPENAI_MODEL, effort: process.env.OPENAI_REASONING_EFFORT, key: process.env.OPENAI_API_KEY };
  try {
    process.env.OPENAI_MODEL = "model-x";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_REASONING_EFFORT = "none";
    envFileSources.delete("OPENAI_MODEL");
    assert.deepEqual(modelFromEnv(), { model: "model-x", source: "env", reasoningEffort: "none" });
    stubFetch(200, completion({ content: "ok" }));
    const { createClientFromEnv } = await import("../src/llm/index.js");
    await createClientFromEnv().chat(messages, []);
    assert.equal(requests[0].reasoning_effort, "none");
  } finally {
    for (const [name, value] of [["OPENAI_MODEL", saved.model], ["OPENAI_REASONING_EFFORT", saved.effort], ["OPENAI_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an unknown OPENAI_REASONING_EFFORT stops the harness at startup with a clear message", async () => {
  const { missingEnv } = await import("../src/llm/index.js");
  const saved = { effort: process.env.OPENAI_REASONING_EFFORT, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "m";
    process.env.OPENAI_REASONING_EFFORT = "nonee";
    assert.equal(missingEnv(), 'OPENAI_REASONING_EFFORT="nonee" is not one of none, minimal, low, medium, high.');
    process.env.OPENAI_REASONING_EFFORT = "none";
    assert.equal(missingEnv(), null);
  } finally {
    for (const [name, value] of [["OPENAI_REASONING_EFFORT", saved.effort], ["OPENAI_API_KEY", saved.key], ["OPENAI_MODEL", saved.model]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
