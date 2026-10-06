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
