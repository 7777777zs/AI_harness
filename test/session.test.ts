// Session files: the append-only JSONL history behind `harness --continue`. No API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "../src/llm/types.js";
import { loadSession, SessionError, sessionFile, SessionWriter } from "../src/session.js";

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
