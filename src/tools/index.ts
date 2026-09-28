// Tool registry: name -> { description, parameters (JSON Schema), execute }
import type { Tool } from "../types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { runShell } from "./runShell.js";

export const tools: Tool[] = [readFile, writeFile, runShell];

export const toolMap = new Map(tools.map((t) => [t.name, t]));
