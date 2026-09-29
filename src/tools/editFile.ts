import fs from "node:fs/promises";
import { DENIED, type Tool } from "../types.js";
import { optBool, requireString, resolveInCwd, toRel } from "./util.js";
import { applyReplacements, dominantEol, normalizeEol, parseText, serialize, toLF } from "./textFormat.js";

/** Remove spaces/tabs at the end of every line (for the "only trailing whitespace differs" hint). */
const stripTrailingWhitespace = (s: string) => s.replace(/[ \t]+(?=\n|$)/g, "");

const MAX_HUNKS = 3;
const MAX_HUNK_LINES = 12; // per side

/** Start offsets of the non-overlapping occurrences of `needle` in `haystack`. */
export function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** 1-based line number of each (ascending) offset. */
function lineNumbers(text: string, offsets: number[]): number[] {
  const out: number[] = [];
  let line = 1;
  let nl = text.indexOf("\n");
  for (const off of offsets) {
    while (nl !== -1 && nl < off) {
      line++;
      nl = text.indexOf("\n", nl + 1);
    }
    out.push(line);
  }
  return out;
}

const countNewlines = (s: string) => s.split("\n").length - 1;
/** Number of lines `s` spans when inserted (a trailing newline does not start another line). */
const spanLines = (s: string) => Math.max(1, countNewlines(s) + (s.endsWith("\n") ? 0 : 1));

function describeLines(starts: number[], span: number): string {
  const parts = starts.map((l) => (span > 1 ? `${l}-${l + span - 1}` : `${l}`));
  return `${span > 1 || parts.length > 1 ? "lines" : "line"} ${parts.join(", ")}`;
}

function cap(lines: string[], prefix: string): string[] {
  const shown = lines.slice(0, MAX_HUNK_LINES).map((l) => prefix + l);
  if (lines.length > MAX_HUNK_LINES) shown.push(`${prefix}… (${lines.length - MAX_HUNK_LINES} more lines)`);
  return shown;
}

/** Compact line diff for one replacement at `pos`: changed lines only, plus one line of shared context. */
function hunk(content: string, pos: number, oldS: string, newS: string, line: number): string {
  const ls = content.lastIndexOf("\n", pos - 1) + 1;
  let le = content.indexOf("\n", pos + oldS.length);
  if (le === -1) le = content.length;
  const before = content.slice(ls, le).split(/\r?\n/);
  const after = (content.slice(ls, pos) + newS + content.slice(pos + oldS.length, le)).split(/\r?\n/);
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < before.length - pre && suf < after.length - pre && before.at(-1 - suf) === after.at(-1 - suf)) suf++;
  const removed = before.slice(pre, before.length - suf);
  const added = after.slice(pre, after.length - suf);
  const out = [`@@ line ${line + pre} @@`];
  if (pre > 0) out.push(` ${before[pre - 1]}`);
  out.push(...cap(removed, "-"), ...cap(added, "+"));
  if (suf > 0) out.push(` ${before[before.length - suf]}`);
  return out.join("\n");
}

export const editFile: Tool = {
  name: "edit_file",
  description:
    "Edit an existing text file by replacing an exact string. `old_str` must match the file exactly " +
    "(including whitespace and indentation) and, unless replace_all is true, occur exactly once; include a few " +
    "surrounding lines to make it unique. Use this instead of write_file to change existing files. " +
    "Requires user confirmation.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      old_str: { type: "string", description: "Exact text to replace" },
      new_str: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_str", "new_str"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const p = requireString(args, "path");
    let oldS = requireString(args, "old_str");
    let newS = requireString(args, "new_str");
    const replaceAll = optBool(args, "replace_all") ?? false;
    const file = resolveInCwd(ctx.cwd, p);
    const rel = toRel(ctx.cwd, file);
    if (oldS === "") throw new Error("old_str must not be empty (use write_file to create a new file)");
    if (oldS === newS) throw new Error("old_str and new_str are identical; nothing to change");

    // Match against the LF-normalized text without BOM (what read_file shows), then write back in
    // the file's own style: untouched lines keep their line endings, the BOM is preserved.
    const parsed = parseText(await fs.readFile(file, "utf8"));
    const content = toLF(parsed.lines);
    oldS = normalizeEol(oldS);
    newS = normalizeEol(newS);
    if (oldS === newS) throw new Error("old_str and new_str are identical; nothing to change");
    const positions = findAll(content, oldS);
    if (positions.length === 0) {
      // Say so when only trailing whitespace differs: the model can't see trailing spaces in its own text.
      const stripped = findAll(stripTrailingWhitespace(content), stripTrailingWhitespace(oldS));
      if (stripped.length > 0) {
        const lines = lineNumbers(stripTrailingWhitespace(content), stripped);
        throw new Error(
          `old_str not found in ${rel}, but it matches (${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}) ` +
            "if trailing whitespace is ignored: the whitespace at the end of some lines differs from the file. " +
            "Copy the exact text, including trailing spaces or tabs, or re-read the lines with read_file.",
        );
      }
      throw new Error(
        `old_str not found in ${rel}. It must match the file exactly, including whitespace and indentation; ` +
          "read the file again and copy the exact text.",
      );
    }
    const oldLines = lineNumbers(content, positions);
    if (positions.length > 1 && !replaceAll) {
      throw new Error(
        `old_str occurs ${positions.length} times in ${rel} (lines ${oldLines.join(", ")}). ` +
          "Include more surrounding lines to make it unique, or set replace_all to true.",
      );
    }

    // Build the new file and the new line number of each replacement.
    const delta = countNewlines(newS) - countNewlines(oldS);
    const newStarts = oldLines.map((l, i) => l + i * delta);
    const updated = applyReplacements(
      parsed,
      positions.map((pos) => ({ start: pos, end: pos + oldS.length, text: newS })),
    );

    const n = positions.length;
    const eol = dominantEol(parsed.lines);
    const style = [eol === "\r\n" ? "CRLF line endings" : "", parsed.bom ? "BOM" : ""].filter(Boolean).join(", ");
    const hunks = positions.slice(0, MAX_HUNKS).map((pos, i) => hunk(content, pos, oldS, newS, oldLines[i]!));
    if (n > MAX_HUNKS) hunks.push(`… and ${n - MAX_HUNKS} more replacement${n - MAX_HUNKS === 1 ? "" : "s"}`);
    const approved = await ctx.confirm(
      `edit_file -> ${rel} (${n} replacement${n === 1 ? "" : "s"}${style ? `, ${style} preserved` : ""})\n${hunks.join("\n")}`,
    );
    if (!approved) return DENIED;

    await fs.writeFile(file, serialize(updated), "utf8");
    const where = newS === "" ? `at ${describeLines(newStarts, 1)}, text deleted` : describeLines(newStarts, spanLines(newS));
    return `Edited ${rel}: replaced ${n} occurrence${n === 1 ? "" : "s"} (${where})`;
  },
};
