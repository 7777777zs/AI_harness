import type { EvalTask } from "../types.js";
import { fail, lines, pass, read, write } from "../helpers.js";

const FN = "computeShippingCost";

// A small ESM project. Traps: the definition, an import, a comment, a string, and a
// similarly named function (computeShippingCostLegacy) are not call sites.
const FILES: Record<string, string> = {
  "lib/shipping.js": `// Shipping cost helpers.
const RATES = { domestic: 4.5, eu: 9, world: 15 };

export function ${FN}(weightKg, zone) {
  const rate = RATES[zone] ?? RATES.world;
  return Math.round(weightKg * rate * 100) / 100;
}

export function ${FN}Legacy(weightKg) {
  return ${FN}(weightKg, "domestic") * 1.1;
}
`,
  "src/checkout.js": `import { ${FN} } from "../lib/shipping.js";
import { formatPrice } from "./util/format.js";

export function checkout(cart) {
  const subtotal = cart.items.reduce((s, i) => s + i.price, 0);
  const shipping = ${FN}(cart.weightKg, cart.zone);
  return { subtotal, shipping, total: formatPrice(subtotal + shipping) };
}

export function expressCheckout(cart) {
  const base = checkout(cart);
  const express = 2 * ${FN}(cart.weightKg, cart.zone);
  return { ...base, express };
}
`,
  "src/cart/summary.js": `import { ${FN} } from "../../lib/shipping.js";

// Note: ${FN} is cheap, so it is not cached here.
export function summary(cart) {
  const lines = cart.items.map((i) => \`\${i.name}: \${i.price}\`);
  lines.push(\`shipping: \${${FN}(cart.weightKg, cart.zone)}\`);
  return lines.join("\\n");
}
`,
  "src/api/quote.js": `import { ${FN}, ${FN}Legacy } from "../../lib/shipping.js";

function log(msg) {
  if (process.env.DEBUG) console.log(msg);
}

export function quote(req) {
  log("${FN} called for a quote");
  if (req.legacy) return ${FN}Legacy(req.weightKg);
  return ${FN}(req.weightKg, req.zone ?? "world");
}
`,
  "src/util/format.js": `export function formatPrice(value) {
  return value.toFixed(2);
}

export function formatWeight(kg) {
  return \`\${kg} kg\`;
}
`,
  "src/util/zones.js": `export const ZONES = ["domestic", "eu", "world"];

export function isZone(z) {
  return ZONES.includes(z);
}
`,
  "test/shipping.test.js": `import assert from "node:assert";
import { ${FN} } from "../lib/shipping.js";

assert.strictEqual(${FN}(2, "eu"), 18);
assert.strictEqual(typeof ${FN}, "function");
`,
  "README.md": `# shop

Shipping costs are computed by \`${FN}\` in lib/shipping.js.
`,
};

/** file:line for every call of FN (not the definition), computed from the fixture itself. */
function expectedSites(): string[] {
  const call = new RegExp(`\\b${FN}\\s*\\(`);
  const definition = new RegExp(`function\\s+${FN}\\s*\\(`);
  const sites: string[] = [];
  for (const [file, content] of Object.entries(FILES)) {
    if (!file.endsWith(".js")) continue;
    lines(content).forEach((l, i) => {
      if (call.test(l) && !definition.test(l) && !/^\s*\/\//.test(l) && !l.includes(`"${FN} called`)) sites.push(`${file}:${i + 1}`);
    });
  }
  return sites;
}

export const task: EvalTask = {
  id: "find-call-sites",
  description: "Find every call site of a function across a small project and report file:line",
  prompt:
    `Find all call sites of the function ${FN} anywhere in the repository, including test files. ` +
    "Only actual calls count: not its definition, " +
    `imports, comments, strings, or other functions whose names merely start with ${FN}. ` +
    "Write the call sites to call-sites.txt, one per line, formatted as relative/path/to/file.js:LINE " +
    "(path relative to the current directory, 1-based line number), and also list them in your final answer.",
  setup(dir) {
    for (const [file, content] of Object.entries(FILES)) write(dir, file, content);
  },
  check(dir) {
    const content = read(dir, "call-sites.txt");
    if (content === null) return fail("call-sites.txt was not created");
    const reported = new Set<string>();
    for (const raw of lines(content)) {
      const l = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!l) continue;
      const m = /^(.+?):(\d+)\b/.exec(l);
      if (!m) return fail(`unparseable line in call-sites.txt: ${JSON.stringify(raw)}`);
      reported.add(`${m[1]}:${m[2]}`);
    }
    const expected = expectedSites();
    const missing = expected.filter((s) => !reported.has(s));
    const extra = [...reported].filter((s) => !expected.includes(s));
    if (missing.length || extra.length) {
      return fail(`missing: [${missing.join(", ")}]; extra: [${extra.join(", ")}]`);
    }
    return pass();
  },
};
