// The skill router on its own: one router call per task (no main-model calls), compared with
// expected labels. Reports precision and recall, and what each false positive would cost.
//   npx tsx evals/route-check.ts [--runs N]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "../src/config.js";
import { estimateTokens } from "../src/context/tokens.js";
import { createClientFromEnv, missingEnv } from "../src/llm/index.js";
import { bundledSkillsDir, discoverSkills } from "../src/skills/load.js";
import { routeSkill } from "../src/skills/router.js";
import { tasks } from "./tasks/index.js";

/**
 * Expected routing. Tasks not listed expect no skill. "either" tasks accept the skill or no
 * skill and are left out of precision/recall: they ask for per-file summaries, which is close
 * to, but not the same as, an architecture overview.
 */
const EXPECTED: Record<string, string> = {
  "fix-bug": "bugfix-with-test",
  "project-overview": "codebase-onboarding",
  onboarding: "codebase-onboarding",
  bugfix: "bugfix-with-test",
  "web-research": "web-research",
  "code-review": "code-review",
};
const EITHER: Record<string, string> = {
  "multi-file-summary": "codebase-onboarding",
  "trustworthy-summary": "codebase-onboarding",
  "summary-with-footer": "codebase-onboarding",
};
/** The 19 core tasks and the 4 skill tasks (Phase 5's web tasks need a browser; not included). */
const PHASE5_WEB = new Set(["read-page", "multi-page", "long-page", "prompt-injection"]);

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "1" } } });
loadEnv();
const missing = missingEnv();
if (missing) {
  console.error(`Error: ${missing}`);
  process.exit(1);
}
const model = process.env.COMPACT_MODEL || process.env.OPENAI_MODEL!;
const client = createClientFromEnv(model);
const all = discoverSkills([bundledSkillsDir()]).skills;
const pinnedTokens = Object.fromEntries(all.map((s) => [s.name, estimateTokens([{ role: "system", content: s.body }])]));

// Steps per task from the latest core-suite run (skills off), to estimate a false positive's cost.
const RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const steps: Record<string, number> = {};
for (const f of fs.readdirSync(RESULTS).filter((x) => x.endsWith(".json")).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(RESULTS, f), "utf8"));
  if ((j.options.skills ?? "off") !== "off") continue;
  for (const r of j.results) steps[r.taskId] = r.steps;
}

interface Row {
  task: string;
  expected: string;
  got: string;
  reason: string;
  verdict: string;
  tokens: number;
}
const rows: Row[] = [];
let tp = 0;
let fp = 0;
let fn = 0;
let routerTokens = 0;
for (let run = 1; run <= Number(args.runs); run++) {
  for (const task of tasks.filter((t) => !PHASE5_WEB.has(t.id))) {
    // Availability as in a real run: web-research needs the browser, which only its own task has.
    const available = all.filter((s) => s.requires.mcp.length === 0 || task.mcpServers);
    const prompt = typeof task.prompt === "function" ? task.prompt({ baseUrl: "http://127.0.0.1:8080" }) : task.prompt;
    const d = await routeSkill(client, prompt, available);
    routerTokens += d.usage.inputTokens + d.usage.outputTokens;
    const expected = EXPECTED[task.id] ?? (EITHER[task.id] ? `${EITHER[task.id]} or none` : "none");
    const got = d.skill ?? "none";
    let verdict: string;
    if (EITHER[task.id]) verdict = got === "none" || got === EITHER[task.id] ? "ok (either)" : "wrong";
    else if (got === (EXPECTED[task.id] ?? "none")) {
      verdict = got === "none" ? "true negative" : "true positive";
      if (got !== "none") tp++;
    } else if (got === "none") {
      verdict = "false negative";
      fn++;
    } else {
      verdict = EXPECTED[task.id] ? "wrong skill" : "false positive";
      fp++;
      if (EXPECTED[task.id]) fn++;
    }
    // A false positive pins the skill into every request of the run.
    const extra = got !== "none" && (verdict === "false positive" || verdict === "ok (either)") ? pinnedTokens[got]! * (steps[task.id] ?? 1) : 0;
    rows.push({ task: task.id, expected, got, reason: d.error ?? d.reason, verdict, tokens: extra });
    process.stdout.write(".");
  }
}
console.log(`\nRouter model: ${model}; ${rows.length} decisions; router tokens: ${routerTokens.toLocaleString("en-US")}\n`);
console.log("| task | expected | routed | verdict | extra input tokens (skill pinned where none was required) | router's reason |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.task} | ${r.expected} | ${r.got} | ${r.verdict} | ${r.tokens || ""} | ${r.reason.replace(/\|/g, "/")} |`);
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
console.log(`\nPrecision ${tp}/${tp + fp} = ${(precision * 100).toFixed(0)}%; recall ${tp}/${tp + fn} = ${(recall * 100).toFixed(0)}% (the "either" tasks are excluded).`);
console.log(`Pinned skill sizes (tokens): ${JSON.stringify(pinnedTokens)}`);
