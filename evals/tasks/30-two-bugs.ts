import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalTask } from "../types.js";
import { fail, keepsAllLines, nodeTest, pass, read, write } from "../helpers.js";

// Hard suite: two bugs that hide each other. The coupon lookup is case-sensitive (the README says
// codes are not), and the discount is subtracted after tax instead of before. With either bug
// alone fixed, the reported total is still wrong (10800, then 9800 instead of 9720).
export const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "checkout", version: "0.9.2", type: "module", scripts: { test: "node --test" } }, null, 2),
  "README.md": `# checkout

\`total(items, { coupon, taxRate })\` returns a cart's total in cents.

- Coupons take a percentage off the subtotal. Coupon codes are case-insensitive: SAVE10, save10 and Save10 are the same coupon. An unknown code is ignored.
- Tax (8% unless \`taxRate\` says otherwise) is charged on the discounted amount.

Run the tests with \`npm test\`.
`,
  "src/cart.js": `import { findCoupon } from "./coupons.js";

/** Cart total in cents, rounded to a whole cent. */
export function total(items, { coupon, taxRate = 0.08 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  const percent = coupon ? (findCoupon(coupon)?.percent ?? 0) : 0;
  const discount = Math.round((subtotal * percent) / 100);
  const taxed = Math.round(subtotal * (1 + taxRate));
  return taxed - discount;
}
`,
  "src/coupons.js": `const COUPONS = [
  { code: "SAVE10", percent: 10 },
  { code: "WELCOME5", percent: 5 },
];

/** The coupon with this code, or undefined. */
export function findCoupon(code) {
  return COUPONS.find((c) => c.code === code.trim());
}
`,
  "test/cart.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

const cart = [{ priceCents: 2500, qty: 4 }];

test("no coupon: subtotal plus 8% tax", () => assert.equal(total(cart), 10800));
test("the tax rate can be changed", () => assert.equal(total(cart, { taxRate: 0.2 }), 12000));
test("coupon save10 from the bug report", () => assert.equal(total(cart, { coupon: "save10" }), 9720));
`,
  "test/coupons.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { findCoupon } from "../src/coupons.js";

test("a known coupon", () => assert.equal(findCoupon("SAVE10").percent, 10));
test("an unknown coupon", () => assert.equal(findCoupon("NOPE"), undefined));
`,
};
const ORIGINAL_TESTS = ["test/cart.test.js", "test/coupons.test.js"];

const A = [{ priceCents: 2500, qty: 4 }];
const B = [{ priceCents: 1999, qty: 3 }];
const C = [{ priceCents: 1999, qty: 3 }, { priceCents: 450, qty: 2 }];
/** [items, options, expected total] checked on the fixed code. */
const HIDDEN: [unknown[], Record<string, unknown>, number][] = [
  [A, { coupon: "save10" }, 9720],
  [A, { coupon: "SAVE10" }, 9720],
  [A, { coupon: "Welcome5" }, 10260],
  [A, {}, 10800],
  [B, { coupon: "save10" }, 5829],
  [B, { coupon: "BOGUS" }, 6477],
  [A, { coupon: "save10", taxRate: 0 }, 9000],
  [C, { coupon: "welcome5" }, 7076],
];

export const task: EvalTask = {
  id: "two-bugs",
  description: "Hard: a wrong total caused by two bugs that hide each other; existing tests must not be changed",
  prompt:
    'Bug report from checkout: a cart of 4 items at $25.00 with coupon "save10" is charged $108.00 instead of $97.20 ' +
    "(10% off, then 8% tax). test/cart.test.js already has a failing test for it. Fix the bug without changing the existing tests.",
  suite: "hard",
  maxSteps: 30,
  setup(dir) {
    for (const [p, c] of Object.entries(FILES)) write(dir, p, c);
  },
  check(dir) {
    const problems: string[] = [];
    const probe = `const { total } = await import(${JSON.stringify(pathToFileURL(path.join(dir, "src/cart.js")).href)});
const cases = ${JSON.stringify(HIDDEN)};
console.log(JSON.stringify(cases.filter(([items, opts, want]) => total(items, opts) !== want)
  .map(([items, opts, want]) => JSON.stringify(opts) + ": got " + total(items, opts) + ", want " + want)));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
    let wrong: string[];
    try {
      wrong = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "[]");
    } catch {
      wrong = [`checker could not run: ${r.stderr.slice(0, 200)}`];
    }
    if (wrong.length) problems.push(`not fixed: ${wrong.join("; ")}`);
    const editedTests = ORIGINAL_TESTS.filter((t) => !keepsAllLines(FILES[t]!, read(dir, t) ?? ""));
    if (editedTests.length) problems.push(`existing tests changed or deleted: ${editedTests.join(", ")}`);
    const suite = nodeTest(dir);
    if (!suite.ok) problems.push("npm test fails");
    const details = { wrongCases: wrong.length, testsKept: editedTests.length === 0, testsPass: suite.ok };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
