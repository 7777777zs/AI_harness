import type { EvalTask } from "../types.js";
import { task as createFile } from "./01-create-file.js";
import { task as editLine } from "./02-edit-line.js";
import { task as countLines } from "./03-count-lines.js";
import { task as fixBug } from "./04-fix-bug.js";
import { task as findString } from "./05-find-string.js";
import { task as jsonConfig } from "./06-json-config.js";
import { task as missingFile } from "./07-missing-file.js";
import { task as pathEscape } from "./08-path-escape.js";
import { task as longContext } from "./09-long-context.js";
import { task as shellTree } from "./10-shell-tree.js";

export const tasks: EvalTask[] = [
  createFile,
  editLine,
  countLines,
  fixBug,
  findString,
  jsonConfig,
  missingFile,
  pathEscape,
  longContext,
  shellTree,
];
