import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { globToRegExp } from "./globMatch.js";
import { isSearchableFile } from "./glob.js";
import { newStats, walk, WALK_BUDGET } from "./walk.js";
import { optBool, optInt, optString, requireString, resolveInCwd, toRel } from "./util.js";

export const GREP_MAX_FILE_BYTES = 1024 * 1024;
export const GREP_MAX_LINE_CHARS = 300;
export const GREP_MAX_CONTEXT = 5;
export const GREP_DEFAULT_RESULTS = 100;
export const GREP_MAX_RESULTS = 500;
const BINARY_SNIFF_BYTES = 8000;
/** Files read concurrently while searching. */
const READ_AHEAD = 32;

const clip = (s: string) => (s.length > GREP_MAX_LINE_CHARS ? `${s.slice(0, GREP_MAX_LINE_CHARS)} …[line truncated]` : s);

export const grep: Tool = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression (read-only). Output lines look like " +
    "'path:line: text' (context lines: 'path-line- text', groups separated by '--'). Paths are relative to the " +
    "working directory and use '/'. Skips .gitignore'd paths, .git, node_modules, .venv, venv, __pycache__, dist, " +
    "build, binary files and files over 1 MB. Prefer this over findstr/grep in run_shell.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression, e.g. \\bfetchUser\\(" },
      path: { type: "string", description: 'File or directory to search, relative to the working directory (default ".")' },
      glob: { type: "string", description: "Only search files matching this glob, e.g. *.ts or src/**/*.py" },
      case_insensitive: { type: "boolean", description: "Ignore case (default false)" },
      context_lines: { type: "integer", description: `Lines of context around each match (default 0, max ${GREP_MAX_CONTEXT})` },
      max_results: {
        type: "integer",
        description: `Maximum number of matching lines to return (default ${GREP_DEFAULT_RESULTS}, max ${GREP_MAX_RESULTS})`,
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    const p = optString(args, "path") ?? ".";
    const globPattern = optString(args, "glob");
    const ci = optBool(args, "case_insensitive") ?? false;
    const context = optInt(args, "context_lines", { min: 0, max: GREP_MAX_CONTEXT }) ?? 0;
    const maxResults = optInt(args, "max_results", { min: 1, max: GREP_MAX_RESULTS }) ?? GREP_DEFAULT_RESULTS;

    let re: RegExp;
    try {
      re = new RegExp(pattern, ci ? "i" : "");
    } catch (err) {
      throw new Error(`Invalid regex "${pattern}": ${(err as Error).message}`);
    }
    const globRe = globPattern ? globToRegExp(globPattern) : null;
    const target = resolveInCwd(ctx.cwd, p);
    const st = await fs.stat(target);

    // Candidate files: [absolute path, path shown in output].
    const stats = newStats();
    async function* candidates(): AsyncGenerator<[string, string]> {
      if (!st.isDirectory()) {
        yield [target, toRel(ctx.cwd, target)];
        return;
      }
      for await (const e of walk(ctx.cwd, target, { stats })) {
        if (!isSearchableFile(ctx.cwd, e)) continue;
        if (globRe && !globRe.test(e.relToStart)) continue;
        yield [e.abs, e.rel];
      }
    }

    const out: string[] = [];
    let matches = 0;
    let filesWithMatches = 0;
    let limitHit = false;
    let skippedLarge = 0;
    let skippedBinary = 0;

    // Read files with bounded parallelism, consumed in walk order (so output stays deterministic).
    // Awaiting stat+read one file at a time left the I/O idle most of the time on large trees.
    type Loaded = { rel: string; buf: Buffer | null; large: boolean };
    const load = async ([abs, rel]: [string, string]): Promise<Loaded> => {
      try {
        if ((await fs.stat(abs)).size > GREP_MAX_FILE_BYTES) return { rel, buf: null, large: true };
        return { rel, buf: await fs.readFile(abs), large: false };
      } catch {
        return { rel, buf: null, large: false }; // vanished or unreadable: skip
      }
    };
    async function* loaded(): AsyncGenerator<Loaded> {
      const queue: Promise<Loaded>[] = [];
      for await (const c of candidates()) {
        queue.push(load(c));
        if (queue.length >= READ_AHEAD) yield await queue.shift()!;
      }
      while (queue.length) yield await queue.shift()!;
    }

    for await (const { rel, buf, large } of loaded()) {
      if (large) {
        skippedLarge++;
        continue;
      }
      if (!buf) continue;
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        skippedBinary++;
        continue;
      }
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();

      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        if (matches === maxResults) {
          limitHit = true;
          break;
        }
        hits.push(i);
        matches++;
      }
      if (hits.length === 0) {
        if (limitHit) break;
        continue;
      }
      filesWithMatches++;

      if (context === 0) {
        for (const i of hits) out.push(`${rel}:${i + 1}: ${clip(lines[i]!)}`);
      } else {
        // Merge overlapping or adjacent context windows into groups separated by "--".
        const hitSet = new Set(hits);
        let groupEnd = -2;
        for (const h of hits) {
          const from = Math.max(0, h - context, groupEnd + 1);
          const to = Math.min(lines.length - 1, h + context);
          if (from > groupEnd + 1 && out.length > 0) out.push("--");
          for (let i = from; i <= to; i++) {
            out.push(hitSet.has(i) ? `${rel}:${i + 1}: ${clip(lines[i]!)}` : `${rel}-${i + 1}- ${clip(lines[i]!)}`);
          }
          groupEnd = Math.max(groupEnd, to);
        }
      }
      if (limitHit) break;
    }

    const notes: string[] = [];
    if (limitHit) notes.push(`stopped at max_results=${maxResults}; more matches exist`);
    if (skippedBinary) notes.push(`${skippedBinary} binary file${skippedBinary === 1 ? "" : "s"} skipped`);
    if (skippedLarge) notes.push(`${skippedLarge} file${skippedLarge === 1 ? "" : "s"} over 1 MB skipped`);
    if (stats.budgetHit) notes.push(`search stopped after examining ${WALK_BUDGET.toLocaleString("en-US")} entries`);
    const extra = notes.length ? `; ${notes.join("; ")}` : "";

    if (matches === 0) return `No matches for /${pattern}/ in ${toRel(ctx.cwd, target)}${extra ? ` [${notes.join("; ")}]` : ""}`;
    out.push(`[${matches} match${matches === 1 ? "" : "es"} in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"}${extra}]`);
    return out.join("\n");
  },
};
