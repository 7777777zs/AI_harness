// I39 offline check: for each run whose log has an after-notes follow-up, merge the reply that got
// the follow-up with the final reply the way A1 now does, and re-run the task's check on a fresh
// fixture with the final reply alone and with the merged text. No API calls; results are not changed.
// Runs whose recorded outcome the fresh fixture cannot reproduce (per-sandbox data, or checks of
// files the run changed) are reported as not re-checkable.
//   npx tsx evals/i39-remerge.ts <results.json | results dir>...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeAnswers, type AgentResult } from "../src/agent.js";
import { tasks } from "./tasks/index.js";

const ROOT = path.join(import.meta.dirname, "..");
const files = process.argv
  .slice(2)
  .flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith(".json")).map((f) => path.join(p, f)) : [p]));
let merges = 0;
let changed = 0;
for (const file of files) {
  const { model, results } = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const r of results) {
    const logFile = path.resolve(ROOT, r.logFile ?? "");
    if (!r.logFile || !fs.existsSync(logFile)) continue;
    const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const nudged = events.filter((e) => e.type === "nudge" && e.kind === "after_notes").map((e) => e.step as number);
    if (!nudged.length) continue;
    const steps = events.filter((e) => e.type === "step");
    const candidate: string = steps.find((s) => s.step === nudged.at(-1))?.response.text ?? "";
    const final: string | undefined = steps.filter((s) => s.step > nudged.at(-1)! && !s.response.toolCalls.length && s.response.text).at(-1)?.response.text;
    if (final === undefined) continue;
    const merged = mergeAnswers([candidate, final]);
    if (!merged.merged) continue;
    merges++;
    const task = tasks.find((t) => t.id === r.taskId)!;
    // A fresh fixture per check: some checks keep per-sandbox state (code-review's tree hash).
    const checkWith = async (text: string, history: string[]) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i39-remerge-"));
      try {
        await task.setup?.(dir);
        const result = { finalText: text, answerHistory: history, toolCalls: r.toolCalls ?? {}, logFile, untrustedGuard: [] } as unknown as AgentResult;
        return (await task.check(dir, result, {})).pass;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const alone = await checkWith(final, [final]);
    if (alone !== (r.outcome === "pass")) {
      console.log(`${model} ${r.taskId}#${r.run}: merged, not re-checkable offline (recorded ${r.outcome})`);
      continue;
    }
    const withMerge = await checkWith(merged.text, [candidate, final]);
    if (withMerge !== alone) changed++;
    console.log(`${model} ${r.taskId}#${r.run}: merged; final alone ${alone ? "pass" : "fail"} -> merged ${withMerge ? "pass" : "fail"}`);
  }
}
console.log(`${merges} run(s) would merge; ${changed} re-checked outcome(s) change`);
