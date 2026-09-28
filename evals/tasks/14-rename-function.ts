import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

const FILES: Record<string, string> = {
  "src/stats.mjs": `// Basic statistics helpers.
export function calcAvg(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function calcAvgWeighted(values, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  return values.reduce((sum, v, i) => sum + v * weights[i], 0) / total;
}

export function spread(values) {
  return Math.max(...values) - calcAvg(values);
}
`,
  "src/report.mjs": `import { calcAvg, calcAvgWeighted } from "./stats.mjs";

export function report(scores) {
  const avg = calcAvg(scores).toFixed(1);
  const weighted = calcAvgWeighted(scores, scores.map(() => 1)).toFixed(1);
  return \`avg=\${avg} weighted=\${weighted}\`;
}
`,
  "src/grades/summary.mjs": `import * as stats from "../stats.mjs";

export const classAverage = (rows) => stats.calcAvg(rows.map((r) => r.score));

export function best(rows) {
  const avg = stats.calcAvg(rows.map((r) => r.score));
  return rows.filter((r) => r.score >= avg).map((r) => r.name);
}
`,
  "src/index.mjs": `export { calcAvg, calcAvgWeighted, spread } from "./stats.mjs";
export { report } from "./report.mjs";
export { classAverage, best } from "./grades/summary.mjs";
`,
  // Keep check.js CommonJS even if a parent directory has "type": "module".
  "package.json": '{ "type": "commonjs" }\n',
};

/** Verifies the rename. The eval rewrites this file before running it, so edits to it do not count. */
const CHECK_JS = `// Verifies that calcAvg was renamed to calculateAverage everywhere.
const fs = require("fs");
const path = require("path");

(async () => {
  const errors = [];
  const stats = await import("./src/stats.mjs");
  const index = await import("./src/index.mjs");
  const { report } = await import("./src/report.mjs");
  const summary = await import("./src/grades/summary.mjs");

  if (typeof stats.calculateAverage !== "function") errors.push("src/stats.mjs does not export calculateAverage");
  if ("calcAvg" in stats) errors.push("src/stats.mjs still exports calcAvg");
  if (typeof stats.calcAvgWeighted !== "function") errors.push("calcAvgWeighted must keep its name");
  if (typeof index.calculateAverage !== "function") errors.push("src/index.mjs does not re-export calculateAverage");
  if (typeof index.calcAvgWeighted !== "function") errors.push("src/index.mjs must still re-export calcAvgWeighted");
  if (typeof stats.calculateAverage === "function" && stats.calculateAverage([2, 4, 9]) !== 5) errors.push("calculateAverage([2,4,9]) !== 5");
  if (stats.spread([2, 4, 9]) !== 4) errors.push("spread([2,4,9]) !== 4");
  if (report([2, 4]) !== "avg=3.0 weighted=3.0") errors.push("report([2,4]) returned " + JSON.stringify(report([2, 4])));
  if (summary.classAverage([{ score: 1 }, { score: 3 }]) !== 2) errors.push("classAverage is wrong");
  if (summary.best([{ name: "a", score: 1 }, { name: "b", score: 3 }]).join() !== "b") errors.push("best is wrong");

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".mjs") ? [path.join(dir, d.name)] : [],
    );
  for (const file of walk(path.join(__dirname, "src"))) {
    fs.readFileSync(file, "utf8").split(/\\r?\\n/).forEach((line, i) => {
      if (/\\bcalcAvg\\b/.test(line)) errors.push("calcAvg still used at " + path.relative(__dirname, file) + ":" + (i + 1));
    });
  }

  if (errors.length) {
    console.error(errors.join("\\n"));
    process.exit(1);
  }
  console.log("rename verified");
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
`;

export const task: EvalTask = {
  id: "rename-function",
  description: "Rename a function and update every call site, import and export; verified by node check.js",
  prompt:
    "Rename the function calcAvg to calculateAverage everywhere in this project, updating all of its call sites, " +
    "imports and re-exports. Do not rename calcAvgWeighted or anything else. When done, run `node check.js` to verify.",
  setup(dir) {
    for (const [file, content] of Object.entries(FILES)) write(dir, file, content);
    write(dir, "check.js", CHECK_JS);
  },
  check(dir) {
    write(dir, "check.js", CHECK_JS);
    write(dir, "package.json", FILES["package.json"]!);
    const run = spawnSync(process.execPath, ["check.js"], { cwd: dir, encoding: "utf8", timeout: 15_000 });
    if (run.status !== 0) {
      const msg = (run.stderr || run.stdout).split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ");
      return fail(`node check.js exited ${run.status}: ${msg}`);
    }
    return pass();
  },
};
