import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreCodeReview } from "../evals/scoring.js";
import { reviewCalibrationCases } from "../evals/fixtures/review-calibration.js";
import { task } from "../evals/tasks/27-code-review.js";
import { runAgent } from "../src/agent.js";

for (const sample of reviewCalibrationCases) {
  test(`review grader calibration: ${sample.id}`, () => {
    assert.equal(scoreCodeReview(sample.answer).outcome, sample.expected);
  });
}

test("review task rejects a known false alarm and still accepts a clean review", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-review-grader-"));
  try {
    for (const id of ["two-real-defects", "two-defects-plus-false-alarm"]) {
      const sample = reviewCalibrationCases.find((c) => c.id === id)!;
      const cwd = path.join(root, id);
      fs.mkdirSync(cwd);
      await task.setup!(cwd);
      const result = await runAgent({
        task: "Review the change.", cwd, quiet: true, logDir: path.join(root, "logs"),
        skillsEnabled: false, skillRouter: false, prefinishMax: 0,
        coverageCheck: false, coverageFooter: false, mcp: { servers: {} },
        client: { async chat() { return { text: sample.answer, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: null }; } },
      });
      const check = await task.check(cwd, result, {});
      assert.equal(check.pass, sample.expected);
      assert.equal(check.details?.unchanged, true);
      if (!sample.expected) assert.match(check.reason!, /harmless rename/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review task reports low recall and the rename false alarm as separate problems", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-review-reasons-"));
  try {
    const reasons: Record<string, string> = {};
    for (const id of ["two-defects-plus-false-alarm", "only-one-defect"]) {
      const sample = reviewCalibrationCases.find((c) => c.id === id)!;
      const cwd = path.join(root, id);
      fs.mkdirSync(cwd);
      await task.setup!(cwd);
      const answer = id === "only-one-defect" ? `${sample.answer}\n\n\n- src/format.js:2: The rename from value to dollars is a bug and must be reverted.` : sample.answer;
      const result = await runAgent({
        task: "Review the change.", cwd, quiet: true, logDir: path.join(root, "logs"),
        skillsEnabled: false, skillRouter: false, prefinishMax: 0,
        coverageCheck: false, coverageFooter: false, mcp: { servers: {} },
        client: { async chat() { return { text: answer, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: null }; } },
      });
      reasons[id] = (await task.check(cwd, result, {})).reason!;
    }
    // Enough recall: only the false alarm. Low recall plus the false alarm: both.
    assert.equal(reasons["two-defects-plus-false-alarm"], "harmless rename in format.js reported as a defect");
    assert.match(reasons["only-one-defect"], /found 1 of 3 planted defects.*; harmless rename in format\.js reported as a defect/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("calibration report: reproducible provenance (no branch, no post-commit diff hash; line-ending independent hashes)", async () => {
  const { calibrationReport, sourceSha256 } = await import("../evals/review-calibration.js");
  assert.equal(sourceSha256("a\r\nb\r\n"), sourceSha256("a\nb\n"));
  const report = calibrationReport();
  assert.ok(!("branch" in report) && !("trackedDiffSha256" in report));
  assert.deepEqual([report.legacy.agreement, report.current.agreement, report.legacy.falseAccepts, report.current.falseAccepts], [5, 7, 2, 0]);
});
