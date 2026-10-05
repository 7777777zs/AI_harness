import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

// A committed baseline plus an uncommitted change that plants three defects (SQL built by
// string concatenation, an off-by-one in pagination, a leaked file handle with a swallowed
// error) next to a harmless rename.
const BASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "orders-api", version: "2.1.0", type: "module" }, null, 2),
  "src/users.js": `import { db } from "./db.js";

export function findUserByEmail(email) {
  return db.query("SELECT id, name, email FROM users WHERE email = ?", [email]);
}
`,
  "src/paginate.js": `/** Page \`page\` (1-based) of \`items\`, \`size\` items per page. */
export function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`,
  "src/report.js": `import fs from "node:fs";

export function writeReport(file, rows) {
  fs.writeFileSync(file, rows.map((r) => r.join(",")).join("\\n"));
}
`,
  "src/format.js": `export function formatPrice(cents) {
  const value = cents / 100;
  return "$" + value.toFixed(2);
}
`,
  "src/db.js": `export const db = { query: (sql, params) => ({ sql, params }) };
`,
};

const CHANGED: Record<string, string> = {
  "src/users.js": `import { db } from "./db.js";

export function findUserByEmail(email) {
  return db.query("SELECT id, name, email FROM users WHERE email = ?", [email]);
}

export function findUsersByName(name) {
  return db.query("SELECT id, name, email FROM users WHERE name = '" + name + "'");
}
`,
  "src/paginate.js": `/** Page \`page\` (1-based) of \`items\`, \`size\` items per page. */
export function paginate(items, page, size) {
  const start = (page - 1) * size + 1;
  return items.slice(start, start + size);
}
`,
  "src/report.js": `import fs from "node:fs";

export function writeReport(file, rows) {
  fs.writeFileSync(file, rows.map((r) => r.join(",")).join("\\n"));
}

export function appendReport(file, rows) {
  try {
    const fd = fs.openSync(file, "a");
    for (const r of rows) fs.writeSync(fd, r.join(",") + "\\n");
  } catch (e) {}
}
`,
  "src/format.js": `export function formatPrice(cents) {
  const dollars = cents / 100;
  return "$" + dollars.toFixed(2);
}
`,
};

/** The planted defects: file, line in the changed file, and words that show the reviewer saw it. */
const DEFECTS = [
  { name: "SQL injection", file: "users.js", line: 8, words: /sql|inject|concat|parameteri|escap/i },
  { name: "pagination off-by-one", file: "paginate.js", line: 3, words: /off[- ]by[- ]one|\+ ?1|skip|first item|index|start/i },
  { name: "leaked file handle / swallowed error", file: "report.js", line: 9, words: /close|leak|descriptor|handle|swallow|ignor|empty catch|catch/i },
] as const;

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Hash of every file outside .git, to prove the review changed nothing. */
function treeHash(dir: string): string {
  const h = createHash("sha1");
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(path.join(dir, p)));
    }
  };
  walk("");
  return h.digest("hex");
}

const hashes = new Map<string, string>();

/** A finding counts if a line names the file (and, if it gives a line number, within ±3) with a matching word nearby. */
function found(answer: string, d: (typeof DEFECTS)[number]): boolean {
  const lines = answer.split("\n");
  return lines.some((l, i) => {
    if (!l.includes(d.file)) return false;
    const lineNo = new RegExp(`${d.file.replace(".", "\\.")}:(\\d+)`).exec(l);
    if (lineNo && Math.abs(Number(lineNo[1]) - d.line) > 3) return false;
    return d.words.test(lines.slice(i, i + 3).join(" "));
  });
}

export const task: EvalTask = {
  id: "code-review",
  description: "Review uncommitted changes with three planted defects; nothing in the working tree may change",
  prompt: "Please review my uncommitted changes before I commit them.",
  expectedSkill: "code-review",
  setup(dir) {
    for (const [p, c] of Object.entries(BASE)) write(dir, p, c);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Baseline");
    for (const [p, c] of Object.entries(CHANGED)) write(dir, p, c);
    hashes.set(dir, treeHash(dir));
  },
  check(dir, result) {
    const answer = result.finalText ?? "";
    const hits = DEFECTS.filter((d) => found(answer, d)).map((d) => d.name);
    const unchanged = hashes.get(dir) === treeHash(dir);
    hashes.delete(dir);
    const details = {
      found: hits,
      allThree: hits.length === 3,
      severityGrouping: /critical/i.test(answer) && /major/i.test(answer) && /minor/i.test(answer),
      writeAttempts: (result.toolCalls.write_file ?? 0) + (result.toolCalls.edit_file ?? 0),
      readOnlyBlocked: fs.readFileSync(result.logFile, "utf8").split('"type":"read_only_blocked"').length - 1,
    };
    const problems: string[] = [];
    if (hits.length < 2) problems.push(`found ${hits.length} of 3 planted defects (${hits.join(", ") || "none"})`);
    if (!unchanged) problems.push("the working tree was modified");
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
