import path from "node:path";
import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

/**
 * A1/A2 regression: a per-file summary under an 8k context in a repo that also has many data
 * fixtures the task doesn't need. The final answer must keep the per-file summaries (even after a
 * coverage check follow-up) AND end with the harness coverage footer listing what was not read.
 */

const SOURCES: [string, string, string][] = [
  ["src/auth.py", "Authenticates users with hashed passwords", "verify_password"],
  ["src/billing.py", "Computes monthly invoices", "compute_invoice"],
  ["src/cache.py", "An in-memory TTL cache", "TtlCache"],
  ["src/cli.py", "Command-line entry point", "main_cli"],
  ["src/config.py", "Loads settings from environment variables", "load_settings"],
  ["src/db.py", "Opens and pools database connections", "get_connection"],
  ["src/email.py", "Sends notification e-mails", "send_email"],
  ["src/export.py", "Exports reports to CSV", "export_csv"],
  ["src/metrics.py", "Records request latency metrics", "record_latency"],
  ["src/queue.py", "A background job queue", "enqueue_job"],
  ["src/search.py", "Full-text search over documents", "search_documents"],
  ["src/storage.py", "Stores uploaded files on disk", "save_upload"],
];
const DATA_FILES = 50;
const FOOTER = "--- Coverage (reported by harness)";

function source(purpose: string, fn: string, i: number): string {
  let pad = "";
  for (let k = 0; pad.length < 1_800; k++) pad += `# Maintenance note ${i}.${k}: keep this module small and documented.\n`;
  return `"""${purpose}."""\n\n${pad}\n\ndef ${fn}(*args, **kwargs):\n    """${purpose}."""\n    return None\n`;
}

export const task: EvalTask = {
  id: "summary-with-footer",
  description: "Per-file summary under an 8k context; answer keeps the summaries and ends with the harness coverage footer",
  prompt: "Summarize each source file under src/ in one sentence.",
  contextLimit: 8_000,
  compactThreshold: 0.7,
  setup(dir) {
    SOURCES.forEach(([p, purpose, fn], i) => write(dir, p, source(purpose, fn, i)));
    for (let i = 0; i < DATA_FILES; i++) write(dir, `data/fixtures/sample_${String(i).padStart(2, "0")}.json`, `{"id": ${i}, "value": "fixture"}\n`);
    write(dir, "README.md", "# service\n\nSource code is in src/; data/fixtures holds test fixtures.\n");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (git("init", "-q").status === 0) {
      git("add", "-A");
      git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
    }
  },
  check(_dir, result) {
    if (result.stopReason !== "done") return fail(`run ended with ${result.stopReason}`);
    const text = result.finalText ?? "";
    const at = text.lastIndexOf(FOOTER);
    if (at === -1) return fail("harness coverage footer missing (data fixtures were known but not read)");
    const body = text.slice(0, at);
    const footer = text.slice(at);
    const missing = SOURCES.map(([p]) => path.posix.basename(p)).filter((b) => !body.includes(b));
    if (missing.length) return fail(`per-file summaries missing for: ${missing.join(", ")}`);
    if (!/Not read: .*data\/fixtures\//.test(footer)) return fail(`footer does not list the unread data files: ${footer.slice(0, 160)}`);
    return pass();
  },
};
