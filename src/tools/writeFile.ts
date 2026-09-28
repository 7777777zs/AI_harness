import fs from "node:fs/promises";
import path from "node:path";
import { DENIED, type Tool } from "../types.js";
import { requireString, resolveInCwd, truncate } from "./util.js";

export const writeFile: Tool = {
  name: "write_file",
  description:
    "Write a UTF-8 text file, overwriting it if it exists. Parent directories are created automatically. The path is relative to the working directory.",
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
    const bytes = Buffer.byteLength(content, "utf8");

    const approved = await ctx.confirm(
      `write_file -> ${path.relative(ctx.cwd, file)} (${bytes} bytes)\n` +
        `--- content preview ---\n${truncate(content, 500)}\n-----------------------`,
    );
    if (!approved) return DENIED;

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `Wrote ${bytes} bytes to ${p}`;
  },
};
