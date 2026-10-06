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
