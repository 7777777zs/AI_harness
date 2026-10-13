// The CLI (src/index.ts) as a child process: settings flags follow the same validation rules as
// environment and .env values, and --help states the full precedence. Fake API; no real calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeApi } from "./fake-api.js";

const ROOT = path.join(import.meta.dirname, "..");
const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-cli-"));
  created.push(d);
  return d;
};

async function cli(args: string[], apiUrl = "http://127.0.0.1:9/v1") {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--cwd", tmp(), ...args], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_HOME: tmp(), OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "fake", OPENAI_BASE_URL: apiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  return { code, stdout, stderr };
}

test("on/off flags accept the same spellings as env/.env values (yes, true, 1, …)", async () => {
  const api = await fakeApi();
  try {
    const r = await cli(["--coverage-check", "yes", "--coverage-footer", "0", "say done"], api.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /COVERAGE_CHECK=on \(option\)/);
    assert.match(r.stdout, /COVERAGE_FOOTER=off \(option\)/);
  } finally {
    api.close();
  }
});

test("bad flag values fail with the shared 'Invalid configuration' messages, naming the flag", async () => {
  for (const [args, message] of [
    [["--max-steps", "abc"], /^Error: Invalid configuration: --max-steps="abc" is not an integer$/m],
    [["--max-steps", "0"], /^Error: Invalid configuration: --max-steps=0 is out of range \(1–500\)$/m],
    [["--compact-threshold", "2"], /^Error: Invalid configuration: --compact-threshold=2 is out of range \(0\.1–0\.95\)$/m],
    [["--coverage-check", "maybe"], /^Error: Invalid configuration: --coverage-check="maybe" must be on or off$/m],
  ] as const) {
    const r = await cli([...args, "x"]);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, message);
  }
});

test("--help states the full settings precedence, including the repository .env", async () => {
  const r = await cli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Settings precedence: these flags > environment variables > .+\.env > .+\.env \(this repository\) > defaults\./);
});

/** Like cli(), but with a fixed working directory and HARNESS_HOME, so two runs share a session. */
async function cliAt(cwd: string, home: string, args: string[], apiUrl = "http://127.0.0.1:9/v1") {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--cwd", cwd, ...args], {
    cwd: ROOT,
    env: { ...process.env, HARNESS_HOME: home, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "fake", OPENAI_BASE_URL: apiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  return { code, stdout, stderr };
}

test("--continue picks up the session the previous run recorded in the same directory", async () => {
  const api = await fakeApi(2);
  try {
    const cwd = tmp();
    const home = tmp();
    const first = await cliAt(cwd, home, ["first question"], api.url);
    assert.equal(first.code, 0, first.stderr);
    const id = /Session: (\S+)/.exec(first.stdout)?.[1];
    assert.ok(id, first.stdout);
    const second = await cliAt(cwd, home, ["--continue", "second question"], api.url);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, new RegExp(`Continuing session ${id}`));
    assert.match(second.stdout, new RegExp(`Session: ${id}`));
  } finally {
    api.close();
  }
});

test("--continue without an earlier session fails with a clear message", async () => {
  const r = await cliAt(tmp(), tmp(), ["--continue", "anything"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no session to continue/);
});

test("--no-session cannot be combined with --continue or --session", async () => {
  const r = await cliAt(tmp(), tmp(), ["--no-session", "--continue", "x"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--no-session cannot be used with --continue or --session/);
  const both = await cliAt(tmp(), tmp(), ["--continue", "--session", "abc", "x"]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /either --continue or --session/);
});

test("--no-session records nothing", async () => {
  const api = await fakeApi(1);
  try {
    const home = tmp();
    const r = await cliAt(tmp(), home, ["--no-session", "say done"], api.url);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Session: /);
    assert.equal(fs.existsSync(path.join(home, "sessions")), false);
  } finally {
    api.close();
  }
});

// ---- The server's context window (Ollama: /api/show) ----

const ollamaShow = (parameters: string) => ({ parameters, model_info: { "qwen3.context_length": 40960 }, capabilities: ["completion", "tools"] });

test("an Ollama model whose num_ctx is below CONTEXT_LIMIT is a configuration error before any request", async () => {
  const api = await fakeApi(1, { ollamaShow: ollamaShow('num_ctx 32768\nstop "<|im_end|>"') });
  try {
    const r = await cli(["--context-limit", "60000", "say done"], api.url);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /CONTEXT_LIMIT=60000 is larger than the server's context window for fake \(num_ctx 32768\)/);
    assert.equal(api.chatCalls(), 0, "no chat request was sent");
  } finally {
    api.close();
  }
});

test("an Ollama model whose num_ctx fits CONTEXT_LIMIT runs as usual", async () => {
  const api = await fakeApi(1, { ollamaShow: ollamaShow("num_ctx 32768") });
  try {
    const r = await cli(["--context-limit", "30000", "say done"], api.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Final answer:[\s\S]*done/);
  } finally {
    api.close();
  }
});

test("an Ollama model without num_ctx gets a warning (its window is Ollama's default) and still runs", async () => {
  const api = await fakeApi(1, { ollamaShow: ollamaShow('stop "<|im_end|>"') });
  try {
    const r = await cli(["--context-limit", "30000", "say done"], api.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fake sets no num_ctx/);
  } finally {
    api.close();
  }
});
