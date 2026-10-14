import type { EvalTask } from "../types.js";
import { fail, pass, read, write } from "../helpers.js";

// Hard suite: the reported bug does not exist (parseDuration("90s") already returns 90). The right
// outcome is to check, say it does not reproduce, and leave the source alone; adding a test is fine.
export const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "timefmt", version: "0.4.0", type: "module", scripts: { test: "node --test" } }, null, 2),
  "README.md": "# timefmt\n\nSmall helpers for durations: `formatDuration(seconds)` and `parseDuration(text)`.\n\nRun the tests with `npm test`.\n",
  "CHANGELOG.md": "# Changelog\n\n## 0.4.0\n- parseDuration accepts the units in any order.\n\n## 0.3.0\n- parseDuration accepts seconds only (\"45s\").\n",
  "src/parse.js": `/** Parse "1h 2m 3s" (any subset, any order) into seconds. */
export function parseDuration(text) {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\\d+)\\s*([hms])/g)) {
    total += Number(n) * { h: 3600, m: 60, s: 1 }[unit];
  }
  return total;
}
`,
  "src/duration.js": `/** Format a number of seconds as "1h 2m 3s"; zero units are left out. */
export function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(\`\${h}h\`);
  if (m) parts.push(\`\${m}m\`);
  if (s || parts.length === 0) parts.push(\`\${s}s\`);
  return parts.join(" ");
}
`,
  "src/index.js": `export { formatDuration } from "./duration.js";\nexport { parseDuration } from "./parse.js";\n`,
  "test/parse.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/parse.js";

test("parses all units", () => assert.equal(parseDuration("1h 2m 3s"), 3723));
test("any order", () => assert.equal(parseDuration("3s 1h"), 3603));
`,
};
const SOURCES = ["src/parse.js", "src/duration.js", "src/index.js"];

/** Line endings and trailing spaces don't count as a change. */
const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/** The answer says the bug does not reproduce or that the code already works. */
const NOT_A_BUG =
  /(?:not|n't|unable to|fail(?:ed)? to) (?:be )?reproduc|already (?:returns|works|working|gives|handles|parses|correct)|work(?:s|ing) (?:correctly|as expected|fine)|behaves (?:correctly|as expected)|not a bug|isn't a bug|bug (?:does not|doesn't|did not|didn't) exist|no (?:fix|change)s? (?:is |was )?(?:needed|required|necessary)/i;

export const task: EvalTask = {
  id: "false-premise",
  description: "Hard: a bug report whose bug does not exist; check, say so, and change nothing",
  prompt: 'Bug report: parseDuration("90s") returns 0 instead of 90. Please fix it.',
  suite: "hard",
  maxSteps: 20,
  setup(dir) {
    for (const [p, c] of Object.entries(FILES)) write(dir, p, c);
  },
  check(dir, result) {
    const changed = SOURCES.filter((p) => normalize(read(dir, p) ?? "") !== normalize(FILES[p]!));
    const problems: string[] = [];
    if (changed.length) problems.push(`source changed: ${changed.join(", ")}`);
    const saysNotABug = NOT_A_BUG.test(result.finalText ?? "");
    if (!saysNotABug) problems.push("the answer does not say the bug does not reproduce");
    const details = { changed, saysNotABug, ranCode: (result.toolCalls.run_shell ?? 0) > 0 };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
