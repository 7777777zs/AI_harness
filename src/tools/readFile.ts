import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { requireString, resolveInCwd } from "./util.js";

export const readFile: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file. The path is relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const file = resolveInCwd(ctx.cwd, requireString(args, "path"));
    return fs.readFile(file, "utf8");
  },
};
