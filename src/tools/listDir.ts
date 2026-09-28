import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { newStats, walk, WALK_BUDGET, type WalkEntry } from "./walk.js";
import { formatSize, optInt, optString, resolveInCwd, toRel } from "./util.js";

export const LIST_DIR_MAX_ENTRIES = 500;
export const LIST_DIR_MAX_DEPTH = 5;

/** One output line: "src/", "src/agent.ts (4.1 KB)", "linked/ (link, not followed)". */
export function formatEntry(e: WalkEntry): string {
  if (e.kind === "dir") return `${e.rel}/`;
  if (e.kind === "link") return `${e.rel}${e.linkIsDir ? "/" : ""} (link, not followed)`;
  return `${e.rel} (${formatSize(e.size ?? 0)})`;
}

export const listDir: Tool = {
  name: "list_dir",
  description:
    "List files and directories recursively (read-only). Directories end with '/', files show their size. " +
    "Paths in the output are relative to the working directory and use '/'. Skips .gitignore'd paths and " +
    ".git, node_modules, .venv, venv, __pycache__, dist, build. " +
    `Shows at most ${LIST_DIR_MAX_ENTRIES} entries. Prefer this over shell commands like dir/ls/find.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: 'Directory relative to the working directory (default ".")' },
      depth: {
        type: "integer",
        description: `How many levels to descend: 1 = direct children only (default 2, max ${LIST_DIR_MAX_DEPTH})`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const p = optString(args, "path") ?? ".";
    const depth = optInt(args, "depth", { min: 1, max: LIST_DIR_MAX_DEPTH }) ?? 2;
    const dir = resolveInCwd(ctx.cwd, p);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new Error(`Not a directory: ${toRel(ctx.cwd, dir)} (use read_file for files)`);

    const stats = newStats();
    const lines: string[] = [];
    let omitted = 0;
    for await (const e of walk(ctx.cwd, dir, { maxDepth: depth, stats })) {
      if (lines.length < LIST_DIR_MAX_ENTRIES) lines.push(formatEntry(e));
      else omitted++;
    }
    if (lines.length === 0) lines.push("(empty directory)");
    if (omitted > 0) lines.push(`[${omitted} more entries omitted (limit ${LIST_DIR_MAX_ENTRIES}); list a subdirectory or lower depth]`);
    if (stats.budgetHit) lines.push(`[listing stopped after examining ${WALK_BUDGET.toLocaleString("en-US")} entries]`);
    return lines.join("\n");
  },
};
