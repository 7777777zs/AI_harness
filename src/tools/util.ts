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

export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated, original length ${s.length}]`;
}
