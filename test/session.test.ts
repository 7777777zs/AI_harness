// Session files: the append-only JSONL history behind `harness --continue`. No API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Message } from "../src/llm/types.js";
import {
  findLatestSession,
  INTERRUPTED_RESULT,
  loadSession,
  lockSession,
  repairDangling,
  samePath,
  SessionError,
  sessionFile,
  SessionWriter,
} from "../src/session.js";
import { validatePairing } from "../src/context/turns.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-session-"));
  created.push(d);
  return d;
};

const q = (content: string): Message => ({ role: "user", content });
const answer = (content: string): Message => ({ role: "assistant", content, toolCalls: [] });

test("appended messages load back in order, without a system prompt", () => {
  const w = SessionWriter.create(tmp(), "/project");
  w.run("first", "log-1.jsonl");
  w.append([q("first"), answer("one")]);
  w.append([q("second")]);
  const s = loadSession(w.file);
  assert.equal(s.id, w.id);
  assert.equal(s.cwd, "/project");
  assert.deepEqual(s.history, [q("first"), answer("one"), q("second")]);
  assert.deepEqual(s.repaired, []);
});

test("a checkpoint replaces everything before it", () => {
  const w = SessionWriter.create(tmp(), "/p");
  w.append([q("a"), answer("b")]);
  w.checkpoint([q("summary of a and b")]);
  w.append([q("c")]);
  assert.deepEqual(loadSession(w.file).history, [q("summary of a and b"), q("c")]);
});

test("the latest state and skills records win", () => {
  const w = SessionWriter.create(tmp(), "/p");
  w.state(true);
  w.skills(["demo"]);
  w.state(false);
  w.state(true);
  w.skills(["demo", "other"]);
  const s = loadSession(w.file);
  assert.equal(s.untrustedPending, true);
  assert.deepEqual(s.skills, ["demo", "other"]);
});

test("a torn last line from an interrupted write is ignored, and open() cuts it off", () => {
  const w = SessionWriter.create(tmp(), "/p");
  w.append([q("kept")]);
  fs.appendFileSync(w.file, '{"type":"message","message":{"role":"us');
  assert.deepEqual(loadSession(w.file).history, [q("kept")]);
  const again = SessionWriter.open(w.file, w.id);
  again.append([q("next")]);
  assert.deepEqual(loadSession(w.file).history, [q("kept"), q("next")]);
});

test("an unterminated last line is never loaded, even when it is complete JSON, matching what open() cuts off", () => {
  const w = SessionWriter.create(tmp(), "/p");
  w.append([q("kept")]);
  fs.appendFileSync(w.file, JSON.stringify({ type: "message", message: q("unterminated") })); // no newline
  assert.deepEqual(loadSession(w.file).history, [q("kept")]);
  SessionWriter.open(w.file, w.id).append([q("next")]);
  assert.deepEqual(loadSession(w.file).history, [q("kept"), q("next")]);
});

test("a corrupt line in the middle is an error, not silently skipped", () => {
  const w = SessionWriter.create(tmp(), "/p");
  fs.appendFileSync(w.file, "not json\n");
  w.append([q("x")]);
  assert.throws(() => loadSession(w.file), (e: unknown) => e instanceof SessionError && /line 2/.test(e.message));
});

test("session ids are validated before they become paths", () => {
  assert.throws(() => sessionFile("/s", "../../etc/passwd"), SessionError);
  assert.throws(() => sessionFile("/s", ""), SessionError);
  assert.equal(sessionFile("/s", "2026-10-09T10-00-00-000Z-ab12cd34"), path.join("/s", "2026-10-09T10-00-00-000Z-ab12cd34.jsonl"));
});

test("two sessions created in the same millisecond get different ids", () => {
  const dir = tmp();
  const now = new Date("2026-10-09T10:00:00.000Z");
  assert.notEqual(SessionWriter.create(dir, "/p", now).id, SessionWriter.create(dir, "/p", now).id);
});

test("a missing file or a file without a header is a SessionError", () => {
  const dir = tmp();
  assert.throws(() => loadSession(path.join(dir, "nope.jsonl")), SessionError);
  const f = path.join(dir, "x.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "message", message: q("x") }) + "\n");
  assert.throws(() => loadSession(f), /header/);
});

const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: null,
  toolCalls: ids.map((id) => ({ id, name: "run_shell", args: { command: `echo ${id}` } })),
});
const result = (id: string): Message => ({ role: "tool", toolCallId: id, name: "run_shell", content: `out ${id}` });
const interrupted = (id: string): Message => ({ role: "tool", toolCallId: id, name: "run_shell", content: INTERRUPTED_RESULT });

test("a tool call without a result at the end gets a synthetic interrupted result", () => {
  const { history, repaired } = repairDangling([q("go"), calls("a", "b"), result("a")]);
  assert.deepEqual(repaired, ["b"]);
  assert.deepEqual(history, [q("go"), calls("a", "b"), result("a"), interrupted("b")]);
  assert.equal(validatePairing(history), null);
});

test("a missing result before the next message is inserted before that message", () => {
  const { history, repaired } = repairDangling([q("go"), calls("a"), q("next")]);
  assert.deepEqual(repaired, ["a"]);
  assert.deepEqual(history, [q("go"), calls("a"), interrupted("a"), q("next")]);
});

test("a tool result without its call is dropped", () => {
  const { history, repaired } = repairDangling([q("go"), result("x"), answer("done")]);
  assert.deepEqual(repaired, []);
  assert.deepEqual(history, [q("go"), answer("done")]);
});

test("a complete history comes back unchanged", () => {
  const complete = [q("go"), calls("a"), result("a"), answer("done")];
  assert.deepEqual(repairDangling(complete), { history: complete, repaired: [] });
});

test("loadSession repairs a session that ended between a call and its result", () => {
  const w = SessionWriter.create(tmp(), "/p");
  w.append([q("go"), calls("a")]);
  const s = loadSession(w.file);
  assert.deepEqual(s.repaired, ["a"]);
  assert.deepEqual(s.history.at(-1), interrupted("a"));
});

test("findLatestSession picks the most recently written session of this directory", () => {
  const dir = tmp();
  const older = SessionWriter.create(dir, "/work/a");
  const other = SessionWriter.create(dir, "/work/b");
  const newer = SessionWriter.create(dir, "/work/a");
  const t = Date.now() / 1000;
  fs.utimesSync(older.file, t - 100, t - 100);
  fs.utimesSync(other.file, t, t);
  fs.utimesSync(newer.file, t - 10, t - 10);
  assert.equal(findLatestSession(dir, "/work/a"), newer.file);
  assert.equal(findLatestSession(dir, "/work/b"), other.file);
});

test("findLatestSession returns null without a matching session or without the directory", () => {
  const dir = tmp();
  SessionWriter.create(dir, "/work/a");
  assert.equal(findLatestSession(dir, "/work/zzz"), null);
  assert.equal(findLatestSession(path.join(dir, "missing"), "/work/a"), null);
});

test("samePath compares resolved paths", () => {
  assert.equal(samePath("/x/./y", "/x/y"), true);
  assert.equal(samePath("/x/y", "/x/z"), false);
  if (process.platform === "win32") assert.equal(samePath("C:\Work", "c:\work"), true);
});

test("lockSession refuses a session held by a live process and takes over a stale lock", () => {
  const w = SessionWriter.create(tmp(), "/p");
  const release = lockSession(w.file);
  assert.throws(() => lockSession(w.file, process.pid + 1), (e: unknown) => e instanceof SessionError && /in use/.test(e.message));
  release();
  assert.equal(fs.existsSync(`${w.file}.lock`), false);
  fs.writeFileSync(`${w.file}.lock`, "2147483646"); // no such process
  const again = lockSession(w.file);
  assert.equal(fs.readFileSync(`${w.file}.lock`, "utf8"), String(process.pid));
  again();
});

test("a lock file left empty by a killed process is treated as stale", () => {
  const w = SessionWriter.create(tmp(), "/p");
  fs.writeFileSync(`${w.file}.lock`, ""); // killed between creating the lock and writing the pid
  const release = lockSession(w.file);
  assert.equal(fs.readFileSync(`${w.file}.lock`, "utf8"), String(process.pid));
  release();
});

test("the in-use error names the lock file to delete", () => {
  const w = SessionWriter.create(tmp(), "/p");
  fs.writeFileSync(`${w.file}.lock`, String(process.ppid)); // a live process other than this one
  try {
    assert.throws(() => lockSession(w.file), (e: unknown) => e instanceof SessionError && e.message.includes(`${w.file}.lock`));
  } finally {
    fs.rmSync(`${w.file}.lock`, { force: true });
  }
});

test("a lock is removed when the process exits without releasing it (Ctrl+C calls process.exit)", () => {
  const dir = tmp();
  const w = SessionWriter.create(dir, "/p");
  const sessionTs = pathToFileURL(path.join(import.meta.dirname, "..", "src", "session.ts")).href;
  const script = path.join(dir, "locker.ts");
  fs.writeFileSync(script, `import { lockSession } from ${JSON.stringify(sessionTs)};\nlockSession(process.argv[2]!);\nprocess.exit(0);\n`);
  const r = spawnSync(process.execPath, ["--import", "tsx", script, w.file], { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(`${w.file}.lock`), false);
});
