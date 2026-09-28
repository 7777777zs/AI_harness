// Tool registry: name -> { description, parameters (JSON Schema), execute }
import type { Tool } from "../types.js";
import { readFile } from "./readFile.js";
import { listDir } from "./listDir.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { editFile } from "./editFile.js";
import { writeFile } from "./writeFile.js";
import { runShell } from "./runShell.js";

export const tools: Tool[] = [readFile, listDir, glob, grep, editFile, writeFile, runShell];

export const toolMap = new Map(tools.map((t) => [t.name, t]));
