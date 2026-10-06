// The eval runner's behavior on interruption (P4) and on bad arguments (P6). The runner runs as a
// child process against a local fake chat-completions server; no real API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { registerChild, registerCleanup, shutdownAll } from "../src/process.js";

const ROOT = path.join(import.meta.dirname, "..");
const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-runner-test-"));
  created.push(d);
  return d;
};

test("shutdown cleanups run after the tracked children are shut down", async () => {
  const order: string[] = [];
  const unregister = registerChild(2_147_000_000, async () => void order.push("child")); // a pid that doesn't exist
  registerCleanup(async () => void order.push("cleanup"));
  await shutdownAll(1_000);
  unregister();
  assert.deepEqual(order, ["child", "cleanup"]);
});

/** Chat completions: the first request gets a final answer, every later one hangs. */
function fakeApi(): Promise<{ url: string; close: () => void }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (calls++ > 0) return; // hang
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    }),
  );
}

const evalSandboxes = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("ai-harness-eval-")));

test("Ctrl+C during an eval run: sandboxes are removed and completed runs are saved as partial results (P4)", async () => {
  const api = await fakeApi();
  const resultsDir = tmp();
  const before = evalSandboxes();
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/fixtures/eval-then-sigint.mjs", "--task", "create-file", "--runs", "2", "--concurrency", "2", "--results-dir", resultsDir],
      {
        cwd: ROOT,
        env: { ...process.env, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "fake", OPENAI_BASE_URL: api.url, SIGINT_AFTER_TEXT: "create-file #", SIGINT_AFTER_MS: "30000" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 130, output);
    const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `one results file (${fs.readdirSync(resultsDir).join(", ")})`);
    assert.ok(!fs.readdirSync(resultsDir).some((f) => f.endsWith(".tmp")), "written atomically");
    const results = JSON.parse(fs.readFileSync(path.join(resultsDir, files[0]!), "utf8"));
    assert.equal(results.interrupted, true);
    assert.deepEqual(results.results.map((r: { taskId: string }) => r.taskId), ["create-file"], "the completed run is kept");
    const leaked = [...evalSandboxes()].filter((n) => !before.has(n));
    assert.deepEqual(leaked, [], "no sandbox left behind");
  } finally {
    api.close();
  }
});

test("bad runner arguments print a one-line usage, not a stack trace (P6: `npm run eval --runs 1` passes a bare 1)", async () => {
  for (const argv of [["1"], ["--runz", "1"]]) {
    const child = spawn(process.execPath, ["--import", "tsx", "evals/run.ts", ...argv], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 1, argv.join(" "));
    assert.match(stderr, /^Error: .+\nUsage: npm run eval -- \[--task id\] \[--runs N\]/, stderr);
    assert.match(stderr, /Put -- after "npm run eval" so npm passes the options on/);
    assert.ok(!/\n\s+at /.test(stderr), "no stack trace");
  }
});

test("test/agent.test.ts leaves no temp directories behind (P7)", async () => {
  const leftovers = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("ai-harness-test-")));
  const before = leftovers();
  // A nested `node --test` must not inherit this runner's test context, or it won't run the file.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/setup.ts", "--test", "test/agent.test.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  assert.equal(await new Promise<number | null>((r) => child.on("exit", r)), 0, "agent tests pass");
  assert.match(out, /ℹ pass [1-9]\d*/, "the agent tests actually ran");
  assert.deepEqual([...leftovers()].filter((n) => !before.has(n)), []);
});
