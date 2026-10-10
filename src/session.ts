// Session history: an append-only JSONL file per session, so `harness --continue` can pick up the
// conversation where the previous run left it. The system prompt is never stored; every run
// rebuilds it. After a compaction a checkpoint record holds the whole compacted history, so
// loading starts from the last checkpoint.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message, ToolCall } from "./llm/types.js";

export const SESSION_FORMAT = 1;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export type SessionRecord =
  | { type: "header"; v: number; id: string; cwd: string; createdAt: string }
  | { type: "run"; task: string; logFile: string; at: string }
  | { type: "message"; message: Message }
  | { type: "checkpoint"; messages: Message[] }
  | { type: "state"; untrustedPending: boolean }
  | { type: "skills"; names: string[] };

export interface LoadedSession {
  id: string;
  file: string;
  /** The directory the session was recorded in. */
  cwd: string;
  /** The conversation without the system prompt: the last checkpoint plus everything after it. */
  history: Message[];
  /** The untrusted-content guard was armed when the session was last written. */
  untrustedPending: boolean;
  /** Skills loaded when the session was last written. */
  skills: string[];
  /** Tool call ids that had no result and got a synthetic one while loading. */
  repaired: string[];
}

/** A timestamp (like log file names) plus a random suffix, so parallel runs never collide. */
export function newSessionId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

/** The file of session `id`; ids come from the command line, so they are checked before use. */
export function sessionFile(dir: string, id: string): string {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new SessionError(`invalid session id "${id}"`);
  return path.join(dir, `${id}.jsonl`);
}

/** The result given to a tool call whose real result was never recorded. */
export const INTERRUPTED_RESULT =
  "Error: Interrupted: the harness stopped before this call's result was recorded. " +
  "The action may or may not have happened; check the current state before repeating it.";

/**
 * Make every tool call have exactly one result again, as the API requires: a call without a
 * result gets INTERRUPTED_RESULT (it never retries the call), and a result without a call is
 * dropped.
 */
export function repairDangling(history: Message[]): { history: Message[]; repaired: string[] } {
  const out: Message[] = [];
  const repaired: string[] = [];
  let pending: ToolCall[] = [];
  const flush = () => {
    for (const call of pending) {
      out.push({ role: "tool", toolCallId: call.id, name: call.name, content: INTERRUPTED_RESULT });
      repaired.push(call.id);
    }
    pending = [];
  };
  for (const m of history) {
    if (m.role === "tool") {
      const i = pending.findIndex((c) => c.id === m.toolCallId);
      if (i === -1) continue;
      pending.splice(i, 1);
      out.push(m);
      continue;
    }
    flush();
    out.push(m);
    if (m.role === "assistant") pending = [...m.toolCalls];
  }
  flush();
  return { history: out, repaired };
}

export class SessionWriter {
  private constructor(
    readonly id: string,
    readonly file: string,
  ) {}

  static create(dir: string, cwd: string, now: Date = new Date()): SessionWriter {
    fs.mkdirSync(dir, { recursive: true });
    const id = newSessionId(now);
    const writer = new SessionWriter(id, sessionFile(dir, id));
    writer.write({ type: "header", v: SESSION_FORMAT, id, cwd, createdAt: now.toISOString() });
    return writer;
  }

  /** Append to an existing session. A torn last line (an interrupted write) is cut off first. */
  static open(file: string, id: string): SessionWriter {
    const text = fs.readFileSync(file, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) fs.truncateSync(file, Buffer.byteLength(text.slice(0, end)));
    return new SessionWriter(id, file);
  }

  run(task: string, logFile: string): void {
    this.write({ type: "run", task, logFile, at: new Date().toISOString() });
  }

  append(messages: Message[]): void {
    for (const message of messages) this.write({ type: "message", message });
  }

  checkpoint(history: Message[]): void {
    this.write({ type: "checkpoint", messages: history });
  }

  state(untrustedPending: boolean): void {
    this.write({ type: "state", untrustedPending });
  }

  skills(names: string[]): void {
    this.write({ type: "skills", names });
  }

  private write(record: SessionRecord): void {
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
  }
}

export function loadSession(file: string): LoadedSession {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new SessionError(`session file not found: ${file}`);
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let header: Extract<SessionRecord, { type: "header" }> | undefined;
  let history: Message[] = [];
  let untrustedPending = false;
  let skills: string[] = [];
  for (const [i, line] of lines.entries()) {
    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      // Only the last line can be torn (the process died while writing it).
      if (i === lines.length - 1 && !text.endsWith("\n")) break;
      throw new SessionError(`${file} line ${i + 1}: not valid JSON`);
    }
    if (i === 0) {
      if (record.type !== "header") throw new SessionError(`${file}: missing session header`);
      if (record.v !== SESSION_FORMAT) throw new SessionError(`${file}: unsupported session format ${record.v}`);
      header = record;
      continue;
    }
    if (record.type === "message") history.push(record.message);
    else if (record.type === "checkpoint") history = [...record.messages];
    else if (record.type === "state") untrustedPending = record.untrustedPending;
    else if (record.type === "skills") skills = [...record.names];
  }
  if (!header) throw new SessionError(`${file}: missing session header`);
  const fixed = repairDangling(history);
  return { id: header.id, file, cwd: header.cwd, history: fixed.history, untrustedPending, skills, repaired: fixed.repaired };
}

/** Same directory? Case-insensitive on Windows, where paths are. */
export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** The header of a session file, read from its first line only; null if it has none. */
function readHeader(file: string): Extract<SessionRecord, { type: "header" }> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const record = JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]!) as SessionRecord;
    return record.type === "header" ? record : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The most recently written session recorded in `cwd`, or null. */
export function findLatestSession(dir: string, cwd: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const header = readHeader(file);
    if (!header || !samePath(header.cwd, cwd)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the session's lock file (`<file>.lock`, holding the pid), so two processes never append
 * to the same session. A lock left by a process that no longer runs, or an empty one (killed
 * before it wrote its pid), is taken over. The lock is also removed when the process exits
 * without releasing it (Ctrl+C ends the CLI with process.exit, skipping `finally` blocks).
 */
export function lockSession(file: string, pid: number = process.pid): () => void {
  const lock = `${file}.lock`;
  try {
    fs.writeFileSync(lock, String(pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = Number(fs.readFileSync(lock, "utf8"));
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {
      throw new SessionError(
        `session is in use by another harness process (pid ${holder}); if no harness is running, delete ${lock}`,
      );
    }
    fs.writeFileSync(lock, String(pid));
  }
  const release = () => {
    process.off("exit", release);
    fs.rmSync(lock, { force: true });
  };
  process.on("exit", release);
  return release;
}
