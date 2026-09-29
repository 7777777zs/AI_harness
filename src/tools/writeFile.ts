import fs from "node:fs/promises";
import path from "node:path";
import { DENIED, type Tool } from "../types.js";
import { dominantEol, linesFromLF, normalizeEol, parseText, serialize } from "./textFormat.js";
import { requireString, resolveInCwd, truncate } from "./util.js";

/**
 * The bytes to write. Overwriting an existing file keeps its style: its dominant line ending
 * and its BOM, so a read_file (LF, no BOM) -> write_file round trip leaves an unchanged file
 * byte-identical. New files are written with LF and no BOM.
 */
export async function styledContent(file: string, content: string): Promise<{ text: string; style: string }> {
  const lf = normalizeEol(content.replace(/^﻿/, ""));
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing === null) return { text: lf, style: "" };
  const old = parseText(existing);
  const eol = dominantEol(old.lines);
  const text = serialize({ bom: old.bom, lines: linesFromLF(lf, eol) });
  const style = [eol === "\r\n" ? "CRLF line endings" : "", old.bom ? "BOM" : ""].filter(Boolean).join(", ");
  return { text, style };
}

export const writeFile: Tool = {
  name: "write_file",
  description:
    "Write a UTF-8 text file, overwriting it if it exists (keeping its line-ending style and BOM). Parent " +
    "directories are created automatically. The path is relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const p = requireString(args, "path");
    const content = requireString(args, "content");
    const file = resolveInCwd(ctx.cwd, p);
    const { text, style } = await styledContent(file, content);
    const bytes = Buffer.byteLength(text, "utf8");

    const approved = await ctx.confirm(
      `write_file -> ${path.relative(ctx.cwd, file)} (${bytes} bytes${style ? `, ${style} preserved` : ""})\n` +
        `--- content preview ---\n${truncate(content, 500)}\n-----------------------`,
    );
    if (!approved) return DENIED;

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return `Wrote ${bytes} bytes to ${p}`;
  },
};
