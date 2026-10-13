// Deterministic comparison of the legacy recall-only code-review rule and the current grader, on
// hand-authored answers. No model calls.
//   npx tsx evals/review-calibration.ts [--json]   (or: npm run eval:calibrate -- --json)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scoreCodeReview } from "./scoring.js";
import { reviewCalibrationCases } from "./fixtures/review-calibration.js";

/** sha256 of source text with LF line endings, so a CRLF and an LF checkout give the same hash. */
export const sourceSha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, { cwd: new URL("../", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};

export function calibrationReport() {
  const rows = reviewCalibrationCases.map(({ id, answer, expected }) => {
    const score = scoreCodeReview(answer);
    return { id, expected, legacy: score.found.length >= 2, current: score.outcome, found: score.found, renameFlagged: score.renameFlagged };
  });
  const metrics = (key: "legacy" | "current") => ({
    agreement: rows.filter((r) => r[key] === r.expected).length,
    falseAccepts: rows.filter((r) => r[key] && !r.expected).length,
    falseRejects: rows.filter((r) => !r[key] && r.expected).length,
  });
  return {
    kind: "deterministic-grader-calibration",
    timestamp: new Date().toISOString(),
    // Run on a clean checkout: the scorer and case hashes identify exactly what was measured.
    commit: git("rev-parse", "HEAD"),
    scorerSha256: sourceSha256(fs.readFileSync(new URL("./scoring.ts", import.meta.url), "utf8")),
    casesSha256: sourceSha256(JSON.stringify(reviewCalibrationCases)),
    legacyRule: "found.length >= 2 (same defect matcher; historical recall-only acceptance rule)",
    currentRule: "found.length >= 2 && !renameFlagged",
    limitations:
      "Seven hand-authored examples targeting one known false positive. Not held out; not a model capability or general semantic accuracy benchmark. Other findings remain observations.",
    total: rows.length,
    legacy: metrics("legacy"),
    current: metrics("current"),
    rows,
  };
}

function main(): void {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });
  const report = calibrationReport();
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Offline grader calibration: hand-authored answers, no API calls.");
    console.table(report.rows.map(({ id, expected, legacy, current }) => ({ id, expected, legacy, current })));
    console.log(`Agreement: legacy ${report.legacy.agreement}/${report.total}; current ${report.current.agreement}/${report.total}.`);
    console.log(`False accepts: ${report.legacy.falseAccepts} -> ${report.current.falseAccepts}.`);
    console.log(report.limitations);
  }
  if (report.current.agreement !== report.total) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
