// Re-scores answer-only checks of the hard suite from run logs, after a grader fix: log-needle
// (the concluding list) and false-premise (the "not a bug" wording; runs that changed the source
// stay failed). Prints per-file pass counts; the results files are not changed.
// Usage: npx tsx evals/rescore-hard.ts <results.json>...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentResult } from "../src/agent.js";
import { task as logNeedle } from "./tasks/29-log-needle.js";
import { task as falsePremise } from "./tasks/34-false-premise.js";

/** The model's last reply text in a run log (the final answer, before any harness footer). */
function lastAnswer(logFile: string): string | null {
  const steps = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "step");
  return steps.at(-1)?.response.text ?? null;
}

const pristine = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-hard-"));
await falsePremise.setup!(pristine);
try {
  for (const file of process.argv.slice(2)) {
    const { model, results } = JSON.parse(fs.readFileSync(file, "utf8"));
    const lines: string[] = [];
    for (const id of ["log-needle", "false-premise"]) {
      const runs = results.filter((r: { taskId: string }) => r.taskId === id);
      if (!runs.length) continue;
      let before = 0;
      let after = 0;
      for (const r of runs) {
        if (r.outcome === "pass") before++;
        const finalText = r.stopReason === "done" ? lastAnswer(r.logFile) : null;
        const result = { finalText, toolCalls: r.toolCalls ?? {} } as unknown as AgentResult;
        const pass =
          id === "log-needle"
            ? (await logNeedle.check(pristine, result, {})).pass
            : !String(r.reason ?? "").includes("source changed") && (await falsePremise.check(pristine, result, {})).pass;
        if (pass) after++;
      }
      lines.push(`${id} ${before}/${runs.length} -> ${after}/${runs.length}`);
    }
    if (lines.length) console.log(`${path.basename(file)} ${model}: ${lines.join("; ")}`);
  }
} finally {
  fs.rmSync(pristine, { recursive: true, force: true });
}
