import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

// Hard suite: a multi-file audit whose final answer must be only a JSON array with an exact schema.
// The content has traps (a subpath import, a dynamic import(), a require() in a .cjs file, a
// package named only in a comment, one used only by scripts/ and one only by test/), and the
// format is checked strictly: no code fence, no prose, sorted by name.
export const FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "orders-api",
      version: "1.2.0",
      type: "module",
      dependencies: {
        express: "^4.19.2",
        lodash: "^4.17.21",
        chalk: "^5.3.0",
        dayjs: "^1.11.10",
        "@acme/metrics": "^2.0.0",
        zod: "^3.23.8",
        uuid: "^9.0.1",
      },
      devDependencies: { vitest: "^1.6.0", typescript: "^5.4.5", "@types/express": "^4.17.21" },
    },
    null,
    2,
  ),
  "src/server.js": `import express from "express";
import { counter } from "@acme/metrics";
import { z } from "zod";
import { orderSchema } from "./schema.js";

const requests = counter("requests");
export const app = express();
app.post("/orders", (req, res) => {
  requests.inc();
  const order = orderSchema.extend({ note: z.string().optional() }).parse(req.body);
  res.json(order);
});
`,
  "src/schema.js": `import { z } from "zod";

export const orderSchema = z.object({ id: z.string(), quantity: z.number().int().positive() });
`,
  "src/util.js": `import fp from "lodash/fp.js";

export const pickIds = fp.map("id");
`,
  "src/legacy.cjs": `const _ = require("lodash");

module.exports = { chunk: (xs) => _.chunk(xs, 10) };
`,
  "src/id.js": `/** A new random id (uuid is loaded only when needed). */
export async function newId() {
  const { v4 } = await import("uuid");
  return v4();
}
`,
  "src/date.js": `// We used dayjs here before; the native Date is enough now.
export const today = () => new Date().toISOString().slice(0, 10);
`,
  "scripts/build.js": `import chalk from "chalk";

console.log(chalk.green("build done"));
`,
  "test/server.test.js": `import { describe, it, expect } from "vitest";
import { app } from "../src/server.js";

describe("server", () => it("exists", () => expect(app).toBeTruthy()));
`,
};

export interface AuditEntry {
  name: string;
  version: string;
  dev: boolean;
  used: boolean;
  files: string[];
}

export const EXPECTED: AuditEntry[] = [
  { name: "@acme/metrics", version: "^2.0.0", dev: false, used: true, files: ["src/server.js"] },
  { name: "@types/express", version: "^4.17.21", dev: true, used: false, files: [] },
  { name: "chalk", version: "^5.3.0", dev: false, used: false, files: [] },
  { name: "dayjs", version: "^1.11.10", dev: false, used: false, files: [] },
  { name: "express", version: "^4.19.2", dev: false, used: true, files: ["src/server.js"] },
  { name: "lodash", version: "^4.17.21", dev: false, used: true, files: ["src/legacy.cjs", "src/util.js"] },
  { name: "typescript", version: "^5.4.5", dev: true, used: false, files: [] },
  { name: "uuid", version: "^9.0.1", dev: false, used: true, files: ["src/id.js"] },
  { name: "vitest", version: "^1.6.0", dev: true, used: false, files: [] },
  { name: "zod", version: "^3.23.8", dev: false, used: true, files: ["src/schema.js", "src/server.js"] },
];

const KEYS = ["dev", "files", "name", "used", "version"];

/** Problems with an answer that should be exactly the EXPECTED array. */
export function auditProblems(answer: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.trim());
  } catch {
    return ["the final answer is not only a JSON array (it does not parse as JSON)"];
  }
  if (!Array.isArray(parsed)) return ["the final answer is not only a JSON array"];
  const problems: string[] = [];
  const byName = new Map<string, unknown>();
  const duplicates: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Object.keys(item).sort().join() !== KEYS.join()) {
      problems.push(`an entry without exactly the keys ${KEYS.join(", ")}: ${JSON.stringify(item).slice(0, 80)}`);
      continue;
    }
    const name = String((item as { name: unknown }).name);
    if (byName.has(name)) duplicates.push(name);
    byName.set(name, item);
  }
  if (duplicates.length) problems.push(`duplicate entries: ${duplicates.join(", ")}`);
  for (const want of EXPECTED) {
    const got = byName.get(want.name);
    if (got === undefined) problems.push(`missing: ${want.name}`);
    else if (JSON.stringify(got, KEYS) !== JSON.stringify(want, KEYS)) problems.push(`wrong entry: ${want.name} (${JSON.stringify(got, KEYS)})`);
  }
  const extra = [...byName.keys()].filter((n) => !EXPECTED.some((e) => e.name === n));
  if (extra.length) problems.push(`not in package.json: ${extra.join(", ")}`);
  const names = parsed.map((e) => String((e as { name?: unknown })?.name));
  if (names.join() !== [...names].sort().join()) problems.push("not sorted by name");
  return problems;
}

export const task: EvalTask = {
  id: "dep-audit-json",
  description: "Hard: audit which src/ files import each dependency; the final answer must be only a JSON array with an exact schema",
  prompt:
    "Audit the dependencies in package.json. For each package in dependencies and devDependencies, find the files under src/ " +
    "that import it (import statements, dynamic import() or require(); importing a subpath such as pkg/sub counts as the package). " +
    'Your final answer must be only a JSON array, with no other text and no Markdown code fence: one object per package, ' +
    '{"name": string, "version": the declared version string, "dev": true for devDependencies, "used": true if any src/ file imports it, ' +
    '"files": those src/ files as relative paths like "src/a.js", sorted}, with the objects sorted by name.',
  suite: "hard",
  maxSteps: 30,
  setup(dir) {
    for (const [p, c] of Object.entries(FILES)) write(dir, p, c);
  },
  check(_dir, result) {
    // The model's own last answer: the harness may append a coverage footer to finalText.
    const answer = result.answerHistory.at(-1) ?? result.finalText ?? "";
    const problems = auditProblems(answer);
    const details = { problems: problems.length, fenced: /^\s*```/.test(answer) };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
