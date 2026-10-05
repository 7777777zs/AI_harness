import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { ContextLengthError, type LLMClient, type LLMResponse, type Message } from "../src/llm/types.js";
import { DENIED } from "../src/types.js";

const usage = { inputTokens: 0, outputTokens: 0 };
const final = (text: string): LLMResponse => ({ text, toolCalls: [], usage, raw: null });
const call = (id: string, name: string, args: Record<string, unknown>): LLMResponse => ({
  text: null,
  toolCalls: [{ id, name, args }],
  usage,
  raw: null,
});

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-test-"));
  created.push(dir);
  return dir;
}

/** A fake client: `script` is called for every agent request (not summarizer requests). */
function fakeClient(script: (messages: Message[], n: number) => LLMResponse): LLMClient & { calls: number } {
  const client = {
    calls: 0,
    async chat(messages: Message[], tools: unknown[]) {
      if (tools.length === 0) return final("summary of older turns");
      return script(messages, client.calls++);
    },
  };
  return client;
}

test("a context-length error forces compaction and the retry succeeds", async () => {
  const dir = sandbox();
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "y".repeat(3_000));
  let failed = false;
  const client = fakeClient((messages, n) => {
    if (n < 6) return call(`c${n}`, "read_file", { path: `f${n + 1}.txt` });
    if (!failed) {
      failed = true;
      throw new ContextLengthError("maximum context length exceeded");
    }
    return final(`done after ${messages.length} messages`);
  });

  const result = await runAgent({ task: "read files", cwd: dir, client, quiet: true, contextLimit: 5_000_000 });
  assert.equal(result.stopReason, "done");
  assert.ok(result.compactions >= 1, "forced compaction happened");
  const log = fs.readFileSync(result.logFile, "utf8");
  assert.match(log, /"type":"context_length_error"/);
  assert.match(log, /"type":"compaction"/);
});

test("a second context-length error stops with stopReason error", async () => {
  const client = fakeClient(() => {
    throw new ContextLengthError("maximum context length exceeded");
  });
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true });
  assert.equal(result.stopReason, "error");
  assert.match(result.error!, /even after compaction/);
});

test("compaction triggers automatically once over the threshold", async () => {
  const dir = sandbox();
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "z".repeat(8_000));
  const client = fakeClient((_, n) => (n < 6 ? call(`c${n}`, "read_file", { path: `f${n + 1}.txt` }) : final("ok")));
  const result = await runAgent({ task: "x", cwd: dir, client, quiet: true, contextLimit: 6_000, compactThreshold: 0.7 });
  assert.equal(result.stopReason, "done");
  assert.ok(result.compactions >= 1);
});

test("without autoApprove a denied confirmation reaches the model", async () => {
  const dir = sandbox();
  let toolResult = "";
  const client = fakeClient((messages, n) => {
    if (n === 0) return call("w", "write_file", { path: "a.txt", content: "hi" });
    toolResult = messages.at(-1)!.content ?? "";
    return final("ok");
  });
  const result = await runAgent({ task: "x", cwd: dir, client, quiet: true, confirm: async () => false });
  assert.equal(result.stopReason, "done");
  assert.equal(toolResult, DENIED);
  assert.equal(fs.existsSync(path.join(dir, "a.txt")), false);
});

test("tools are restricted to the cwd passed in, not process.cwd()", async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "inside.txt"), "inside");
  const results: string[] = [];
  const client = fakeClient((messages, n) => {
    if (n > 0) results.push(messages.at(-1)!.content ?? "");
    if (n === 0) return call("a", "read_file", { path: "inside.txt" });
    if (n === 1) return call("b", "read_file", { path: "../outside.txt" });
    return final("ok");
  });
  await runAgent({ task: "x", cwd: dir, client, quiet: true, autoApprove: true });
  assert.deepEqual(results, ["inside", 'Error: Path "../outside.txt" is outside the working directory']);
});

test("every tool result is logged as it is produced, including the last step's (P5)", async () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "a.txt"), "MARKER-P5-4417");
  const client = fakeClient((_, n) => call(`c${n}`, "read_file", { path: "a.txt" }));
  const result = await runAgent({ task: "x", cwd: dir, client, quiet: true, maxSteps: 1 });
  assert.equal(result.stopReason, "max_steps");
  const entries = fs.readFileSync(result.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const logged = entries.filter((e) => e.type === "tool_result");
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].step, logged[0].tool, logged[0].toolCallId], [1, "read_file", "c0"]);
  assert.match(logged[0].content, /MARKER-P5-4417/);
});
