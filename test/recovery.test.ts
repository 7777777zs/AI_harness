// Error recovery and approval defaults, with a mocked LLMClient. No API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { ContextLengthError, type LLMClient, type LLMResponse, type Message, type ToolCall } from "../src/llm/types.js";
import { DENIED } from "../src/types.js";

const usage = { inputTokens: 0, outputTokens: 0 };
const final = (text: string): LLMResponse => ({ text, toolCalls: [], usage, raw: null });
const calls = (...toolCalls: ToolCall[]): LLMResponse => ({ text: null, toolCalls, usage, raw: null });
const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-rec-"));
  created.push(dir);
  return dir;
};
const logTypes = (file: string) =>
  fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).type as string);

interface Recorded {
  agentRequests: Message[][];
  summaryRequests: number;
}

/** Fake client. `script(n, messages)` answers the n-th agent request (requests that offer tools). */
function fakeClient(script: (n: number, messages: Message[]) => LLMResponse): LLMClient & Recorded {
  const rec: Recorded = { agentRequests: [], summaryRequests: 0 };
  return Object.assign(rec, {
    async chat(messages: Message[], tools: unknown[]) {
      if (tools.length === 0) {
        rec.summaryRequests++;
        return final("summary");
      }
      rec.agentRequests.push(structuredClone(messages));
      return script(rec.agentRequests.length - 1, messages);
    },
  });
}

/** Sandbox with `n` files of `size` chars, and a script that reads them one per turn. */
function readingScript(n: number) {
  const dir = sandbox();
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i} `.repeat(500));
  const read = (i: number) => calls({ id: `c${i}`, name: "read_file", args: { path: `f${i}.txt` } });
  return { dir, read };
}

test("E1: one context-length error forces compaction, retries exactly once, and the run continues", async () => {
  const { dir, read } = readingScript(5);
  let thrown = 0;
  const client = fakeClient((n) => {
    if (n < 5) return read(n);
    if (n === 5) {
      thrown++;
      throw new ContextLengthError("This model's maximum context length is 128000 tokens");
    }
    return final("finished");
  });

  const result = await runAgent({ task: "read", cwd: dir, client, quiet: true, contextLimit: 1e9 });

  assert.equal(result.stopReason, "done");
  assert.equal(result.finalText, "finished");
  assert.equal(thrown, 1);
  assert.equal(client.agentRequests.length, 7, "5 reads + failed request + exactly one retry");
  assert.ok(result.compactions >= 1, "compaction was forced");

  const failed = client.agentRequests[5]!;
  const retried = client.agentRequests[6]!;
  // Forced compaction runs Level 1 then Level 2, so turns older than the last 3 are summarized.
  const hasSummary = (ms: Message[]) => ms.some((m) => m.role === "user" && m.content.startsWith("[Summary of earlier conversation"));
  assert.equal(hasSummary(failed), false, "not compacted before the error (limit was huge)");
  assert.equal(hasSummary(retried), true, "retry was sent with compacted context");
  assert.equal(client.summaryRequests, 1, "Level 2 summarizer called once");
  assert.ok(retried.length < failed.length);
  assert.deepEqual(retried.slice(0, 2), failed.slice(0, 2), "system prompt and task kept");

  const types = logTypes(result.logFile);
  const errIdx = types.indexOf("context_length_error");
  assert.ok(errIdx >= 0 && types.indexOf("compaction", errIdx) > errIdx, "log: error followed by compaction");
});

test("E2: two context-length errors in a row stop the run with a clear error", async () => {
  const client = fakeClient(() => {
    throw new ContextLengthError("maximum context length exceeded");
  });
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true });
  assert.equal(result.stopReason, "error");
  assert.match(result.error!, /^Context length exceeded even after compaction: maximum context length exceeded$/);
  assert.equal(client.agentRequests.length, 2, "original request + one retry, no more");
  assert.equal(result.finalText, null);
});

test("E3: a generic network error stops the run cleanly with stopReason error", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { dir, read } = readingScript(1);
    const client = fakeClient((n) => {
      if (n === 0) return read(0);
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    const result = await runAgent({ task: "x", cwd: dir, client, quiet: true });
    assert.equal(result.stopReason, "error");
    assert.equal(result.error, "fetch failed");
    assert.equal(client.agentRequests.length, 2, "no retry for non-context errors");
    assert.equal(result.steps, 2);
    assert.equal(logTypes(result.logFile).at(-1), "result", "result line written to the log");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("E3b: a non-Error throw is also reported as stopReason error", async () => {
  const client = fakeClient(() => {
    throw "socket hang up"; // eslint-disable-line no-throw-literal
  });
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true });
  assert.equal(result.stopReason, "error");
  assert.equal(result.error, "socket hang up");
});

test("E4: invalid JSON tool arguments produce an Error: tool result and the loop continues", async () => {
  let toolResult: Message | undefined;
  const client = fakeClient((n, messages) => {
    if (n === 0) return calls({ id: "bad", name: "read_file", args: null, argsError: "Unexpected token b in JSON at position 1" });
    toolResult = messages.at(-1);
    return final("recovered");
  });
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true });
  assert.equal(result.stopReason, "done");
  assert.equal(result.finalText, "recovered");
  assert.equal(toolResult?.role, "tool");
  assert.equal((toolResult as Extract<Message, { role: "tool" }>).toolCallId, "bad");
  assert.match(toolResult!.content!, /^Error: Invalid JSON arguments: Unexpected token/);
});

// ---- D: autoApprove defaults ----

test("D1: runAgent asks for confirmation by default (autoApprove defaults to false)", async () => {
  const dir = sandbox();
  const asked: string[] = [];
  const client = fakeClient((n) => (n === 0 ? calls({ id: "w", name: "write_file", args: { path: "a.txt", content: "x" } }) : final("ok")));
  await runAgent({ task: "x", cwd: dir, client, quiet: true, confirm: async (s) => (asked.push(s), false) });
  assert.equal(asked.length, 1, "confirm was called");
  assert.equal(fs.existsSync(path.join(dir, "a.txt")), false);
});

test(
  "D2: with neither autoApprove nor confirm, the default terminal prompt denies without a TTY",
  { skip: process.stdin.isTTY ? "stdin is a TTY: the prompt would block" : false },
  async () => {
    const dir = sandbox();
    let toolResult = "";
    const client = fakeClient((n, messages) => {
      if (n === 0) return calls({ id: "s", name: "run_shell", args: { command: "echo should-not-run > ran.txt" } });
      toolResult = messages.at(-1)!.content ?? "";
      return final("ok");
    });
    const result = await runAgent({ task: "x", cwd: dir, client, quiet: true });
    assert.equal(result.stopReason, "done");
    assert.equal(toolResult, DENIED);
    assert.equal(fs.existsSync(path.join(dir, "ran.txt")), false, "shell command did not run");
  },
);

test("D3: the CLI entry point never passes autoApprove", () => {
  const cli = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /autoApprove/);
});
