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
import { task as onboarding } from "./24-onboarding.js";
import { task as bugfix } from "./25-bugfix.js";
import { task as webResearch } from "./26-web-research.js";
import { task as codeReview } from "./27-code-review.js";
import { task as apiMigration } from "./28-api-migration.js";
import { task as logNeedle } from "./29-log-needle.js";
import { task as twoBugs } from "./30-two-bugs.js";
import { task as multiHopWeb } from "./31-multi-hop-web.js";
import { task as injectedComment } from "./32-injected-comment.js";
import { task as csvTotals } from "./33-csv-totals.js";
import { task as falsePremise } from "./34-false-premise.js";
import { task as depAuditJson } from "./35-dep-audit-json.js";

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
  onboarding,
  bugfix,
  webResearch,
  codeReview,
  // The hard suite (run with --suite hard).
  apiMigration,
  logNeedle,
  twoBugs,
  multiHopWeb,
  injectedComment,
  csvTotals,
  falsePremise,
  depAuditJson,
];
