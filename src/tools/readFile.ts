import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { optInt, requireString, resolveInCwd } from "./util.js";

/** Width of the right-aligned line number in "<n>\t<text>" output (like `cat -n`). */
const LINE_NO_WIDTH = 6;

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file. The path is relative to the working directory. Without offset/limit the whole file " +
    "is returned as-is. With offset and/or limit, only that range of lines is returned, each prefixed with its " +
    "line number and a tab; use this for large files (e.g. around a line found with grep).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      offset: { type: "integer", description: "1-based line number to start reading from" },
      limit: { type: "integer", description: "Maximum number of lines to return" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const file = resolveInCwd(ctx.cwd, requireString(args, "path"));
    const offset = optInt(args, "offset", { min: 1 });
    const limit = optInt(args, "limit", { min: 1 });
    const content = await fs.readFile(file, "utf8");
    if (offset === undefined && limit === undefined) return content;

    const lines = content.split(/\r?\n/);
    if (content.endsWith("\n")) lines.pop();
    const total = content === "" ? 0 : lines.length;
    if (total === 0) return "(empty file)";
    const start = offset ?? 1;
    if (start > total) throw new Error(`offset ${start} is past the end of the file (${total} lines)`);
    const end = limit === undefined ? total : Math.min(total, start + limit - 1);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(LINE_NO_WIDTH)}\t${l}`)
      .join("\n");
    return end < total ? `${body}\n[lines ${start}-${end} of ${total}; use offset=${end + 1} to continue]` : body;
  },
};
