// Session history: an append-only JSONL file per session, so `harness --continue` can pick up the
// conversation where the previous run left it. The system prompt is never stored; every run
// rebuilds it. After a compaction a checkpoint record holds the whole compacted history, so
// loading starts from the last checkpoint.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message } from "./llm/types.js";

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
  return { id: header.id, file, cwd: header.cwd, history, untrustedPending, skills, repaired: [] };
}
