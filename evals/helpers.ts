import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CheckResult } from "./types.js";

export function write(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** File content, or null if it does not exist. */
export function read(dir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

export function exists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

export function isDir(dir: string, rel: string): boolean {
  return fs.statSync(path.join(dir, rel), { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function randomCode(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/** Normalize line endings so Windows/Unix differences don't fail checks. */
export function lines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
/** True if every line of `original` still appears in `now`, in order (tests may be added, not changed). */
export function keepsAllLines(original: string, now: string): boolean {
  const have = lf(now).split("\n");
  let i = 0;
  for (const line of lf(original).split("\n")) {
    while (i < have.length && have[i] !== line) i++;
    if (i === have.length) return false;
    i++;
  }
  return true;
}

/** Run an ES module snippet in a fresh Node process; `lastLine` is the last line it printed. */
export function nodeEval(code: string): { ok: boolean; lastLine: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, lastLine: r.stdout.trim().split("\n").at(-1) ?? "", stderr: r.stderr.trim() };
}

/** Deterministic PRNG (mulberry32), for fixtures that must be the same on every run. */
export function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `node --test` in `cwd`. */
export function nodeTest(cwd: string): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, ["--test"], { cwd, encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

export const pass = (): CheckResult => ({ pass: true });
export const fail = (reason: string): CheckResult => ({ pass: false, reason });

/** Largest actual (API-reported) input tokens of a main request in a run log. */
export function maxRequestTokens(logFile: string): number {
  let max = 0;
  try {
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      if (!line.includes('"type":"step"')) continue;
      max = Math.max(max, JSON.parse(line).response?.usage?.inputTokens ?? 0);
    }
  } catch {
    // no log
  }
  return max;
}

/** Remove every directory, even when some fail (e.g. EBUSY on Windows); returns the ones that failed. */
export function removeDirs(
  dirs: Iterable<string>,
  rm: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
): string[] {
  const failed: string[] = [];
  for (const dir of dirs) {
    try {
      rm(dir);
    } catch {
      failed.push(dir);
    }
  }
  return failed;
}
