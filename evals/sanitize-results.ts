// Prepare eval result files for the repository: only the files TEST_REPORT.md refers to, with
// absolute paths replaced by placeholders, and a hard stop if anything looks like a secret.
// Logs (evals/results/logs/) are never committed.
//   npx tsx evals/sanitize-results.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Locations {
  home: string;
  tmp: string;
  repo: string;
  user: string;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every spelling of a path in a results file: raw, JSON-escaped, and with forward slashes. */
function spellings(p: string): string[] {
  const forward = p.replace(/\\/g, "/");
  return [...new Set([p.replace(/\\/g, "\\\\"), p, forward])];
}

/** Replace the temp dir, the repo, the home dir (longest first) and the username with placeholders. */
export function sanitize(text: string, where: Locations): string {
  const paths: [string, string][] = [
    [where.tmp, "<TMP>"],
    [where.repo, "<REPO>"],
    [where.home, "<HOME>"],
  ];
  paths.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [p, placeholder] of paths) {
    for (const spelling of spellings(p)) out = out.replace(new RegExp(escapeRegex(spelling), "gi"), placeholder);
  }
  return out.replace(new RegExp(`(?<![\\w-])${escapeRegex(where.user)}(?![\\w-])`, "gi"), "<USER>");
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\s*[=:]\s*"?[A-Za-z0-9_\-.]{12,}/g, // KEY=value assignments
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}/gi, // authorization headers
];

/** Strings that look like secrets (test placeholders like "sk-test" are too short to match). */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.flatMap((p) => text.match(p) ?? []);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(REPO, "evals", "results");
const BEGIN = "# BEGIN committed eval results (managed by evals/sanitize-results.ts)";
const END = "# END committed eval results";

/** Never committed: edited by hand in Phase 2 to demo the comparison output, so it is not a real result (I24). */
export const HAND_EDITED_RESULTS = new Set(["2026-09-28T00-11-35-377Z.json"]);

/** Results files named in TEST_REPORT.md: full timestamps, or "00-05-06"-style ones from 2026-10-05 tables. */
export function referencedResults(report: string, available: string[]): string[] {
  const full = new Set(report.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g) ?? []);
  const short = new Set([...report.matchAll(/^\| (\d{2}-\d{2}-\d{2}) \|/gm)].map((m) => m[1]!));
  return available
    .filter((f) => !HAND_EDITED_RESULTS.has(f))
    .filter((f) => full.has(f.replace(/\.json$/, "")) || [...short].some((t) => f.startsWith(`2026-10-05T${t}-`)))
    .sort();
}

function main(): void {
  const where: Locations = { home: os.homedir(), tmp: os.tmpdir(), repo: REPO, user: os.userInfo().username };
  const available = fs.readdirSync(RESULTS).filter((f) => f.endsWith(".json"));
  const files = referencedResults(fs.readFileSync(path.join(REPO, "TEST_REPORT.md"), "utf8"), available);
  for (const f of files) {
    const file = path.join(RESULTS, f);
    const clean = sanitize(fs.readFileSync(file, "utf8"), where);
    const secrets = findSecrets(clean);
    if (secrets.length) throw new Error(`${f} contains what looks like a secret (${secrets[0]!.slice(0, 8)}…); not committed`);
    JSON.parse(clean); // still valid JSON
    fs.writeFileSync(`${file}.tmp`, clean);
    fs.renameSync(`${file}.tmp`, file);
  }
  // .gitignore keeps evals/results/* out, except the files listed in the managed block.
  const gitignore = path.join(REPO, ".gitignore");
  const lines = fs.readFileSync(gitignore, "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(BEGIN);
  const kept = start === -1 ? lines : [...lines.slice(0, start), ...lines.slice(lines.indexOf(END) + 1)];
  const block = [BEGIN, ...files.map((f) => `!evals/results/${f}`), END];
  fs.writeFileSync(gitignore, [...kept.filter((l, i) => l || i < kept.length - 1), ...block, ""].join("\n"));
  console.log(`Sanitized ${files.length} referenced results file(s) of ${available.length}; .gitignore updated.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
