import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { globToRegExp } from "./globMatch.js";
import { compareNames, newStats, walk, WALK_BUDGET, type WalkEntry } from "./walk.js";
import { optString, requireString, resolveInCwd, toRel } from "./util.js";

export const GLOB_MAX_RESULTS = 500;

/** Files (and links to files inside cwd) from a walk; links to directories are never followed. */
export function isSearchableFile(cwd: string, e: WalkEntry): boolean {
  if (e.kind === "file") return true;
  if (e.kind !== "link" || e.linkIsDir) return false;
  try {
    resolveInCwd(cwd, e.abs); // a file link pointing outside cwd is skipped
    return true;
  } catch {
    return false;
  }
}

export const comparePaths = (a: string, b: string) => compareNames(a, b);

export const glob: Tool = {
  name: "glob",
  description:
    "Find files by name pattern (read-only), e.g. '**/*.py', 'src/**/*.test.ts', '*.{js,json}'. " +
    "A pattern without '/' matches file names at any depth; a pattern with '/' is matched against the path " +
    "relative to `path`. Returns sorted paths relative to the working directory (with '/'), at most " +
    `${GLOB_MAX_RESULTS}. Skips .gitignore'd paths and .git, node_modules, .venv, venv, __pycache__, dist, build.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.py" },
      path: { type: "string", description: 'Directory to search, relative to the working directory (default ".")' },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    const p = optString(args, "path") ?? ".";
    const re = globToRegExp(pattern);
    const dir = resolveInCwd(ctx.cwd, p);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${toRel(ctx.cwd, dir)}`);

    const stats = newStats();
    const matches: string[] = [];
    for await (const e of walk(ctx.cwd, dir, { stats })) {
      if (isSearchableFile(ctx.cwd, e) && re.test(e.relToStart)) matches.push(e.rel);
    }
    matches.sort(comparePaths);
    const where = p === "." ? "" : ` under ${toRel(ctx.cwd, dir)}`;
    const lines = matches.length ? matches.slice(0, GLOB_MAX_RESULTS) : [`No files match "${pattern}"${where}`];
    if (matches.length > GLOB_MAX_RESULTS) {
      lines.push(`[${matches.length - GLOB_MAX_RESULTS} more matches omitted (limit ${GLOB_MAX_RESULTS}); use a narrower pattern or path]`);
    }
    if (stats.budgetHit) lines.push(`[search stopped after examining ${WALK_BUDGET.toLocaleString("en-US")} entries]`);
    return lines.join("\n");
  },
};
