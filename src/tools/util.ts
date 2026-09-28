import path from "node:path";

export const MAX_OUTPUT = 10_000;

/** Resolve `p` against `cwd`, throwing if the result escapes `cwd`. */
export function resolveInCwd(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the working directory`);
  }
  return abs;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid argument "${key}" (expected string)`);
  }
  return value;
}

export const TRUNCATE_HEAD = 6_000;
export const TRUNCATE_TAIL = 2_000;

/** Number of lines, not counting an empty line after a trailing newline. */
const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

/**
 * Keep the first TRUNCATE_HEAD and last TRUNCATE_TAIL characters of long output, with a
 * marker in between saying how much was cut. The tail often holds the interesting part
 * (summaries, errors, the end of a listing) that a head-only cut would lose.
 */
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, TRUNCATE_HEAD);
  const tail = s.slice(-TRUNCATE_TAIL);
  const omittedChars = s.length - TRUNCATE_HEAD - TRUNCATE_TAIL;
  const totalLines = countLines(s);
  // Lines with no character visible in the head or the tail (lines cut in half count as visible).
  const omittedLines = Math.max(0, totalLines - countLines(head) - countLines(tail));
  const marker =
    `[... truncated: ${omittedChars.toLocaleString("en-US")} chars / ` +
    `${omittedLines.toLocaleString("en-US")} lines omitted (${totalLines.toLocaleString("en-US")} lines total) ...]`;
  return `${head}\n${marker}\n${tail}`;
}
