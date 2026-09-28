import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, read, write } from "../helpers.js";

const SUM_JS = `// Returns the sum of the integers 1..n (inclusive).
function sumTo(n) {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}

module.exports = { sumTo };
`;

const CHECK_JS = `const assert = require("assert");
const { sumTo } = require("./sum.js");

assert.strictEqual(sumTo(0), 0);
assert.strictEqual(sumTo(1), 1);
assert.strictEqual(sumTo(5), 15);
assert.strictEqual(sumTo(10), 55);
console.log("all checks passed");
`;

export const task: EvalTask = {
  id: "fix-bug",
  description: "Fix an off-by-one bug so that `node check.js` exits 0",
  prompt:
    "Running `node check.js` fails. Find and fix the bug in sum.js so that `node check.js` exits with code 0. Do not modify check.js.",
  setup(dir) {
    write(dir, "sum.js", SUM_JS);
    write(dir, "check.js", CHECK_JS);
    // Keep the fixture CommonJS even if a parent directory has "type": "module".
    write(dir, "package.json", '{ "type": "commonjs" }\n');
  },
  check(dir) {
    if (read(dir, "check.js") !== CHECK_JS) return fail("check.js was modified");
    const run = spawnSync(process.execPath, ["check.js"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    if (run.status !== 0) {
      return fail(`node check.js exited ${run.status}: ${(run.stderr || run.stdout).split("\n").find((l) => l.trim()) ?? ""}`);
    }
    return pass();
  },
};
