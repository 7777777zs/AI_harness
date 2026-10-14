import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalTask } from "../types.js";
import { fail, nodeEval, nodeTest, pass, read, write } from "../helpers.js";

// Hard suite: change a function's signature and every caller. The callers are spread over seven
// files and use the function in different ways (an alias import, a namespace import, a call split
// over lines, a level held in a variable), so a search for `log(` alone misses some of them.
export const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shopkit", version: "1.4.0", type: "module", scripts: { test: "node --test" } }, null, 2),
  "README.md": "# shopkit\n\nOrder, payment and inventory helpers. Logging is described in docs/logging.md.\n\nRun the tests with `npm test`.\n",
  "docs/logging.md": `# Logging

Everything logs through \`log\` in src/logger.js. Entries are kept in \`entries\` (the tests read them).

\`\`\`js
import { log } from "./logger.js";
log("warn", "disk almost full");
\`\`\`
`,
  "src/logger.js": `/** Every logged entry, oldest first (the tests read it). */
export const entries = [];

/** Log a message at a level: log("warn", "disk almost full"). */
export function log(level, message) {
  entries.push({ level, message });
}
`,
  "src/orders.js": `import { log } from "./logger.js";

export function placeOrder(id) {
  log("info", \`order \${id} placed\`);
  return id;
}

export function cancelOrder(id, reason) {
  log("warn", \`order \${id} cancelled: \${reason}\`);
}
`,
  "src/payments.js": `import { log as record } from "./logger.js";

export function charge(amount) {
  if (amount <= 0) {
    record("error", "invalid amount, refusing to charge");
    return false;
  }
  record("info", \`charged \${amount}\`);
  return true;
}
`,
  "src/inventory.js": `import * as logger from "./logger.js";

export function restock(sku, count) {
  logger.log(
    "info",
    \`restocked \${sku} x\${count}\`,
  );
}
`,
  "src/audit.js": `import { log } from "./logger.js";

/** Record an audit event at the given level. */
export function audit(level, event) {
  log(level, \`audit: \${event}\`);
}
`,
  "src/util/retry.js": `import { log } from "../logger.js";

/** Call fn up to \`times\` times; null if every attempt throws. */
export function retry(fn, times) {
  for (let i = 1; i <= times; i++) {
    try {
      return fn();
    } catch {
      log("debug", \`attempt \${i} failed, retrying\`);
    }
  }
  log("error", "all attempts failed");
  return null;
}
`,
  "scripts/report.js": `import { entries, log } from "../src/logger.js";

/** Number of entries so far, counting this report. */
export function report() {
  log("info", "report generated");
  return entries.length;
}
`,
  "test/logger.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { entries, log } from "../src/logger.js";

test("log keeps the level and the message", () => {
  log("warn", "disk almost full");
  assert.deepEqual(entries.at(-1), { level: "warn", message: "disk almost full" });
});
`,
  "test/orders.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { entries } from "../src/logger.js";
import { cancelOrder, placeOrder } from "../src/orders.js";

test("placing and cancelling an order is logged", () => {
  placeOrder(7);
  cancelOrder(7, "out of stock");
  assert.deepEqual(entries.slice(-2), [
    { level: "info", message: "order 7 placed" },
    { level: "warn", message: "order 7 cancelled: out of stock" },
  ]);
});
`,
};

/** [module, call, expected entries]; run against the migrated code by the checker. */
const PROBES: [string, string, { level: string; message: string }[]][] = [
  ["src/logger.js", 'm.log("hello")', [{ level: "info", message: "hello" }]],
  ["src/logger.js", 'm.log("careful", { level: "warn" })', [{ level: "warn", message: "careful" }]],
  ["src/orders.js", "m.placeOrder(7)", [{ level: "info", message: "order 7 placed" }]],
  ["src/orders.js", 'm.cancelOrder(7, "out of stock")', [{ level: "warn", message: "order 7 cancelled: out of stock" }]],
  ["src/payments.js", "m.charge(0)", [{ level: "error", message: "invalid amount, refusing to charge" }]],
  ["src/payments.js", "m.charge(5)", [{ level: "info", message: "charged 5" }]],
  ["src/inventory.js", 'm.restock("A1", 3)', [{ level: "info", message: "restocked A1 x3" }]],
  ["src/audit.js", 'm.audit("warn", "login")', [{ level: "warn", message: "audit: login" }]],
  [
    "src/util/retry.js",
    "m.retry(() => { throw new Error(); }, 2)",
    [
      { level: "debug", message: "attempt 1 failed, retrying" },
      { level: "debug", message: "attempt 2 failed, retrying" },
      { level: "error", message: "all attempts failed" },
    ],
  ],
  ["scripts/report.js", "m.report()", [{ level: "info", message: "report generated" }]],
];

/** The entries a call logs, as { level, message } (key order and extra fields don't matter). */
function logged(dir: string, mod: string, call: string): string {
  const url = (rel: string) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const r = nodeEval(`const m = await import(${url(mod)});
const { entries } = await import(${url("src/logger.js")});
const before = entries.length;
${call};
console.log(JSON.stringify(entries.slice(before).map((e) => ({ level: e.level, message: e.message }))));`);
  return r.ok ? r.lastLine : `error: ${r.stderr.split("\n")[0]}`;
}

/** Each probe in a fresh process; returns the probes whose entries differ (or that throw). */
function wrongProbes(dir: string): string[] {
  const wrong: string[] = [];
  for (const [mod, call, want] of PROBES) {
    const got = logged(dir, mod, call);
    if (got !== JSON.stringify(want)) wrong.push(`${mod}: ${call} logged ${got}`);
  }
  // A compatibility branch for the old call would keep unmigrated callers working.
  if (logged(dir, "src/logger.js", 'm.log("warn", "x")') === JSON.stringify([{ level: "warn", message: "x" }])) {
    wrong.push('the old call log("warn", "x") still logs at warn');
  }
  return wrong;
}

export const task: EvalTask = {
  id: "api-migration",
  description: "Hard: change log(level, message) to log(message, { level }) and migrate every caller, the tests and the docs",
  prompt:
    'Change `log` in src/logger.js from `log(level, message)` to `log(message, { level = "info" } = {})`. ' +
    "Update every caller, the tests and the docs to the new signature, and make sure `npm test` passes.",
  suite: "hard",
  maxSteps: 40,
  setup(dir) {
    for (const [p, c] of Object.entries(FILES)) write(dir, p, c);
  },
  check(dir) {
    const wrong = wrongProbes(dir);
    const problems = [...wrong];
    const suite = nodeTest(dir);
    if (!suite.ok) problems.push("npm test fails");
    const docsMigrated = !(read(dir, "docs/logging.md") ?? "").includes('log("warn", "disk almost full")');
    if (!docsMigrated) problems.push("docs/logging.md still shows the old call");
    const details = { wrongProbes: wrong.length, testsPass: suite.ok, docsMigrated };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
