import fs from "node:fs";
import path from "node:path";

export const MAX_OUTPUT = 10_000;

/** True if `abs` is `dir` itself or lies below it (both absolute). */
function isWithin(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

const outsideError = (p: string, why = "") => new Error(`Path "${p}" is outside the working directory${why}`);

/**
 * Resolve `p` against `cwd`, throwing if the result escapes `cwd`.
 *
 * Backslashes are treated as separators on every platform. Besides the lexical check, links
 * are resolved: the deepest part of the path that exists is realpath'd, the not-yet-existing
 * rest is re-appended, and the result must lie inside realpath(cwd). So a symlink or junction
 * inside cwd that points outside cannot be read or written through. A link that cannot be
 * resolved (dangling or looping) is refused, since writing through it could create its
 * target outside cwd. Returns the lexical absolute path.
 *
 * The check happens before the caller uses the path, so a link swapped in between could
 * still escape (a narrow race, accepted for this harness).
 */
export function resolveInCwd(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p.replace(/\\/g, "/"));
  if (!isWithin(cwd, abs)) throw outsideError(p);

  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) break; // reached the root without finding anything
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let realCwd: string;
  try {
    realCwd = fs.realpathSync.native(cwd);
  } catch {
    realCwd = cwd;
  }
  let real: string;
  try {
    real = path.join(fs.realpathSync.native(existing), ...rest);
  } catch {
    throw outsideError(p, " (it goes through a link that cannot be resolved)");
  }
  if (!isWithin(realCwd, real)) throw outsideError(p, " (it resolves through a link)");
  return abs;
}

/** `abs` relative to `cwd` with forward slashes; "." for cwd itself. */
export function toRel(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/") || ".";
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid argument "${key}" (expected string)`);
  }
  return value;
}

/** Optional string argument; absent or null gives undefined. */
export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid argument "${key}" (expected string)`);
  return value;
}

/** Optional boolean argument; also accepts "true"/"false". */
export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`Invalid argument "${key}" (expected boolean)`);
}

/** Optional integer argument (numeric strings accepted), clamped to [min, max]. */
export function optInt(
  args: Record<string, unknown>,
  key: string,
  { min = -Infinity, max = Infinity }: { min?: number; max?: number } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`Invalid argument "${key}" (expected integer)`);
  return Math.min(max, Math.max(min, n));
}

/** Human-readable size: "812 B", "4.1 KB", "2.3 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const TRUNCATE_HEAD = 6_000;
export const TRUNCATE_TAIL = 2_000;

/** Number of lines, not counting an empty line after a trailing newline. */
const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

/**
 * Keep the first TRUNCATE_HEAD and last TRUNCATE_TAIL characters of long output, with a
 * marker in between saying how much was cut. The tail often holds the interesting part
 * (summaries, errors, the end of a listing) that a head-only cut would lose.
 * A `max` smaller than the default shrinks head and tail (3:1) so they fit within `max`.
 */
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const headLen = Math.min(TRUNCATE_HEAD, Math.floor(max * 0.75));
  const tailLen = Math.min(TRUNCATE_TAIL, max - headLen);
  const head = s.slice(0, headLen);
  const tail = tailLen > 0 ? s.slice(-tailLen) : "";
  const omittedChars = s.length - headLen - tailLen;
  const totalLines = countLines(s);
  // Lines with no character visible in the head or the tail (lines cut in half count as visible).
  const omittedLines = Math.max(0, totalLines - countLines(head) - countLines(tail));
  const marker =
    `[... truncated: ${omittedChars.toLocaleString("en-US")} chars / ` +
    `${omittedLines.toLocaleString("en-US")} lines omitted (${totalLines.toLocaleString("en-US")} lines total) ...]`;
  return `${head}\n${marker}\n${tail}`;
}
