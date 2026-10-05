// Offline evaluation of isPlanOnly() on the final answers in past run logs (no API calls).
// Positives: runs known to have ended on a plan (PRE_REGISTERED), plus heuristic hits that manual
// review found were not genuine answers (REVIEWED). Every other final answer is a negative.
//   npx tsx evals/plan-detect-eval.ts [--show-hits]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isPlanOnly } from "../src/prefinish.js";

/** Runs known beforehand to have ended on a plan (the pre-registered positives). */
export const PRE_REGISTERED: [string, string][] = [
  ["2026-10-05T00-31-25-458Z/web-research-1", "I will read each of these pages"],
  ["2026-10-05T00-31-25-458Z/web-research-2", "then proceed to read them"],
];
/**
 * Heuristic hits that manual review found were not genuine final answers either: the run
 * stopped before doing the work. Counted as positives in the "reviewed" figures.
 */
export const REVIEWED: [string, string][] = [
  ["2026-10-05T00-19-11-744Z/trustworthy-summary-1", "Next, I will read the test files"],
  ["2026-09-28T06-03-14-996Z/multi-file-summary-3", "I need to examine the content of some of these files"],
  ["2026-10-05T00-09-59-055Z/bugfix-1", "Please run the tests to confirm"],
];
/** A labeled answer: the run directory and a phrase from that specific answer. */
const labeled = (list: [string, string][], rel: string, text: string) => list.some(([dir, phrase]) => dir === rel && text.includes(phrase));

const { values: args } = parseArgs({ options: { "show-hits": { type: "boolean", default: false } } });
const EVAL_LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "results", "logs");
const USER_LOGS = path.join(process.env.HARNESS_HOME || path.join(os.homedir(), ".harness"), "logs");

interface Answer {
  source: string;
  text: string;
  positive: boolean;
  reviewed: boolean;
}

function finalAnswers(file: string): string[] {
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    const r = JSON.parse(line);
    // Every candidate the model gave as a final answer (including ones a coverage check followed).
    const candidates: string[] = r.answerHistory?.length ? r.answerHistory : r.finalText ? [r.finalText] : [];
    out.push(...candidates.filter((t) => t.trim()));
  }
  return out;
}

function* jsonlFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const answers: Answer[] = [];
for (const [root, label] of [[EVAL_LOGS, "eval"], [USER_LOGS, "user"]] as const) {
  for (const file of jsonlFiles(root)) {
    const rel = path.relative(root, path.dirname(file)).split(path.sep).join("/");
    for (const text of finalAnswers(file)) {
      const positive = label === "eval" && labeled(PRE_REGISTERED, rel, text);
      const reviewed = label === "eval" && labeled(REVIEWED, rel, text);
      answers.push({ source: `${label}:${rel || path.basename(file)}`, text, positive, reviewed });
    }
  }
}

const cjk = (t: string) => /[一-鿿]/.test(t);
const hits = answers.filter((a) => isPlanOnly(a.text));
function report(name: string, isPositive: (a: Answer) => boolean): void {
  const tp = hits.filter(isPositive).length;
  const fp = hits.length - tp;
  const fn = answers.filter((a) => isPositive(a) && !isPlanOnly(a.text)).length;
  const positives = answers.filter(isPositive).length;
  console.log(
    `${name}: ${positives} positives, ${answers.length - positives} negatives; hits ${hits.length} (TP ${tp}, FP ${fp}), missed ${fn}; ` +
      `precision ${hits.length ? ((100 * tp) / hits.length).toFixed(1) : "n/a"}%, recall ${positives ? ((100 * (positives - fn)) / positives).toFixed(1) : "n/a"}%`,
  );
}
console.log(`Final answers: ${answers.length} (${answers.filter((a) => cjk(a.text)).length} with Chinese text)`);
console.log(`  from eval logs: ${answers.filter((a) => a.source.startsWith("eval:")).length}, from user logs: ${answers.filter((a) => a.source.startsWith("user:")).length}`);
report("Pre-registered labels", (a) => a.positive);
report("Reviewed labels", (a) => a.positive || a.reviewed);
if (args["show-hits"]) {
  for (const h of hits) {
    const last = h.text.trim().split(/\n\s*\n/).at(-1)!.replace(/\s+/g, " ");
    console.log(`\n[${h.positive ? "POS" : "neg"}] ${h.source}\n  ${last.slice(0, 300)}`);
  }
}
