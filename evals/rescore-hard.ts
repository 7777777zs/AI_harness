// Re-scores the hard-suite tasks whose checks read only the final answer, from run logs, after a
// grader change: log-needle, multi-hop-web, csv-totals, dep-audit-json, and false-premise (whose
// runs that changed the source stay failed: `details.changed` in the results file). Prints per-file
// pass counts; the results files are not changed.
// Usage: npx tsx evals/rescore-hard.ts <results.json>...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentResult } from "../src/agent.js";
import type { EvalTask } from "./types.js";
import { task as logNeedle } from "./tasks/29-log-needle.js";
import { task as multiHopWeb } from "./tasks/31-multi-hop-web.js";
import { task as csvTotals } from "./tasks/33-csv-totals.js";
import { task as falsePremise } from "./tasks/34-false-premise.js";
import { task as depAuditJson } from "./tasks/35-dep-audit-json.js";

const ANSWER_ONLY: EvalTask[] = [logNeedle, multiHopWeb, csvTotals, falsePremise, depAuditJson];

interface RunRecord {
  taskId: string;
  outcome: string;
  stopReason: string;
  logFile: string;
  toolCalls?: Record<string, number>;
  details?: { changed?: string[] };
}

/** The model's last reply text in a run log (the final answer, before any harness footer). */
function lastAnswer(logFile: string): string | null {
  const steps = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "step");
  return steps.at(-1)?.response.text ?? null;
}

// false-premise's check also compares the sources with the fixture; the unchanged fixture stands
// in for the run's sandbox, and runs that did change the source stay failed below.
const pristine = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-hard-"));
await falsePremise.setup!(pristine);
try {
  for (const file of process.argv.slice(2)) {
    const { model, results } = JSON.parse(fs.readFileSync(file, "utf8")) as { model: string; results: RunRecord[] };
    const lines: string[] = [];
    for (const task of ANSWER_ONLY) {
      const runs = results.filter((r) => r.taskId === task.id);
      if (!runs.length) continue;
      let before = 0;
      let after = 0;
      for (const r of runs) {
        if (r.outcome === "pass") before++;
        const finalText = r.stopReason === "done" ? lastAnswer(r.logFile) : null;
        const result = { finalText, answerHistory: finalText === null ? [] : [finalText], toolCalls: r.toolCalls ?? {} } as unknown as AgentResult;
        const sourceChanged = (r.details?.changed?.length ?? 0) > 0;
        if (!sourceChanged && (await task.check(pristine, result, {})).pass) after++;
      }
      lines.push(`${task.id} ${before}/${runs.length} -> ${after}/${runs.length}`);
    }
    if (lines.length) console.log(`${path.basename(file)} ${model}: ${lines.join("; ")}`);
  }
} finally {
  fs.rmSync(pristine, { recursive: true, force: true });
}
