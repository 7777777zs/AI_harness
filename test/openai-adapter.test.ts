// OpenAI adapter tests with a stubbed global fetch. No real API calls.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
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
