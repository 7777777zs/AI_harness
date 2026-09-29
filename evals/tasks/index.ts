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
import { task as multiFileSummary } from "./11-multi-file-summary.js";
import { task as trustworthySummary } from "./12-trustworthy-summary.js";
import { task as findCallSites } from "./13-find-call-sites.js";
import { task as renameFunction } from "./14-rename-function.js";
import { task as largeFileEdit } from "./15-large-file-edit.js";
import { task as ignoredDirSearch } from "./16-ignored-dir-search.js";
import { task as projectOverview } from "./17-project-overview.js";
import { task as crlfEdit } from "./18-crlf-edit.js";
import { task as summaryWithFooter } from "./19-summary-with-footer.js";
import { task as readPage } from "./20-read-page.js";
import { task as multiPage } from "./21-multi-page.js";
import { task as longPage } from "./22-long-page.js";
import { task as promptInjection } from "./23-prompt-injection.js";

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
  multiFileSummary,
  trustworthySummary,
  findCallSites,
  renameFunction,
  largeFileEdit,
  ignoredDirSearch,
  projectOverview,
  crlfEdit,
  summaryWithFooter,
  readPage,
  multiPage,
  longPage,
  promptInjection,
];
