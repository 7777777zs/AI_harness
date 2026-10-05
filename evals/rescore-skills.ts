// Re-score the with/without-skills runs from their logs, with outcome and process metrics
// separated (evals/scoring.ts). No API calls: reads evals/results/*.json and the run logs.
//   npx tsx evals/rescore-skills.ts [--since 2026-10-05T00-05]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scoreBugfixFromReason, scoreCodeReview, scoreOnboarding, scoreWebResearch } from "./scoring.js";

const RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const SKILL_TASKS = new Set(["onboarding", "bugfix", "web-research", "code-review"]);
const { values: args } = parseArgs({ options: { since: { type: "string", default: "2026-10-05T00-05" } } });

interface Rec {
  taskId: string;
  pass: boolean;
  outcome: string;
  reason?: string;
  logFile?: string;
  trigger?: string;
  skillsLoaded?: string[];
  inputTokens: number;
  outputTokens: number;
  steps: number;
}

function resultEntry(logFile: string): { finalText: string | null; untrustedGuard: unknown[] } | null {
  const file = path.resolve(logFile);
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, "utf8").trim().split("\n").reverse().find((l) => l.includes('"type":"result"'));
  return line ? JSON.parse(line) : null;
}

const rows: string[] = [];
const header = "| file | model | task | condition | n | pass | outcome | process | trigger (correct/none/wrong) | avg tokens | task-specific |";
rows.push(header, header.replace(/[^|]+/g, "---"));

for (const f of fs.readdirSync(RESULTS).filter((x) => x.endsWith(".json") && x >= args.since!).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(RESULTS, f), "utf8"));
  const records = (j.results as Rec[]).filter((r) => SKILL_TASKS.has(r.taskId));
  if (records.length === 0 || new Set(records.map((r) => r.taskId)).size > 1) continue;
  const task = records[0]!.taskId;
  const scored = records.filter((r) => r.outcome !== "error");
  const errors = records.length - scored.length;
  let outcome = 0;
  let process = 0;
  const extra: Record<string, number> = {};
  const add = (k: string, v = 1) => (extra[k] = (extra[k] ?? 0) + v);
  for (const r of scored) {
    const entry = r.logFile ? resultEntry(r.logFile) : null;
    if (task === "bugfix") {
      const s = scoreBugfixFromReason(r.pass, r.reason);
      outcome += +s.outcome;
      process += +s.process;
      add("testsKept", +s.testsKept);
    } else if (!entry) {
      add("noLog");
    } else if (task === "onboarding") {
      const s = scoreOnboarding(entry.finalText);
      outcome += +s.outcome;
      process += +s.process;
      add("coverageNote", +s.coverageNote);
      add("formatHeadings", s.formatHeadings);
    } else if (task === "web-research") {
      const s = scoreWebResearch(entry.finalText, entry.untrustedGuard.length);
      outcome += +s.outcome;
      process += +s.process;
      for (const failure of s.failures) add(failure);
      add("flaggedInjection", +s.flaggedInjection);
      add("endedOnPlan", +s.endedOnPlan);
    } else {
      const s = scoreCodeReview(entry.finalText);
      outcome += +s.outcome;
      process += +s.severityGrouping;
      add("defectsFound", s.found.length);
      add("renameFlagged", +s.renameFlagged);
      add("otherFindings", s.otherFindings);
    }
  }
  const n = scored.length;
  const trig = ["correct", "none", "wrong"].map((t) => scored.filter((r) => r.trigger === t).length);
  const trigger = scored.some((r) => r.trigger) ? trig.join("/") : "–";
  const avgTokens = n ? Math.round(scored.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0) / n) : 0;
  const specific =
    task === "code-review"
      ? `recall ${extra.defectsFound ?? 0}/${3 * n}; rename flagged ${extra.renameFlagged ?? 0}; other findings ${extra.otherFindings ?? 0}`
      : task === "onboarding"
        ? `coverage note ${extra.coverageNote ?? 0}/${n}; format headings avg ${n ? ((extra.formatHeadings ?? 0) / n).toFixed(1) : 0}/7`
        : task === "bugfix"
          ? `existing tests kept ${extra.testsKept ?? 0}/${n}`
          : ["wrong answer", "conflict not mentioned", "missing citations", "injection followed", "flaggedInjection", "endedOnPlan"]
              .map((k) => `${k} ${extra[k] ?? 0}`)
              .join("; ");
  rows.push(
    `| ${f.slice(11, 19)} | ${j.model} | ${task} | ${j.options.skills ?? "off"} | ${n}${errors ? ` (+${errors} err)` : ""} | ` +
      `${scored.filter((r) => r.pass).length}/${n} | ${outcome}/${n} | ${process}/${n} | ${trigger} | ${avgTokens.toLocaleString("en-US")} | ${specific} |`,
  );
}
console.log(rows.join("\n"));
