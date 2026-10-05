// Sanitizing eval result files before they are committed: absolute paths become placeholders,
// and anything that looks like a secret stops the commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets, sanitize } from "../evals/sanitize-results.js";

const where = {
  home: "C:\\Users\\alice",
  tmp: "C:\\Users\\alice\\AppData\\Local\\Temp",
  repo: "C:\\Users\\alice\\code\\AI_harness",
  user: "alice",
};

test("absolute paths (temp, repo, home) and the username become placeholders, raw or JSON-escaped", () => {
  const raw = 'sandbox C:\\Users\\alice\\AppData\\Local\\Temp\\ai-harness-eval-x\\work; repo C:\\Users\\alice\\code\\AI_harness\\evals; home C:\\Users\\alice\\.harness; by alice';
  assert.equal(sanitize(raw, where), "sandbox <TMP>\\ai-harness-eval-x\\work; repo <REPO>\\evals; home <HOME>\\.harness; by <USER>");
  const json = JSON.stringify({ sandbox: "C:\\Users\\alice\\AppData\\Local\\Temp\\ai-harness-eval-x\\work", logFile: "evals\\results\\logs\\a.jsonl" });
  assert.deepEqual(JSON.parse(sanitize(json, where)), { sandbox: "<TMP>\\ai-harness-eval-x\\work", logFile: "evals\\results\\logs\\a.jsonl" });
  // Forward-slash forms too (e.g. URLs in messages, POSIX-style paths).
  assert.equal(sanitize("C:/Users/alice/AppData/Local/Temp/x", where), "<TMP>/x");
});

test("the username is only replaced as a whole word", () => {
  assert.equal(sanitize("malice and alice2 and alice", where), "malice and alice2 and <USER>");
});

test("secrets are detected: API keys, key assignments, bearer tokens; test placeholders are not", () => {
  assert.deepEqual(findSecrets("key sk-proj-abcdefghijklmnop1234567890"), ["sk-proj-abcdefghijklmnop1234567890"]);
  assert.equal(findSecrets("OPENAI_API_KEY=abc123def456ghi789").length, 1);
  assert.equal(findSecrets('"authorization": "Bearer abcdefghijklmnopqrstuvwxyz"').length, 1);
  assert.deepEqual(findSecrets('OPENAI_API_KEY: "sk-test", model gpt-4.1-mini, task sk-ip'), []);
});

test("only the results files TEST_REPORT.md refers to are selected (full timestamps, or short ones in the Phase 6 tables)", async () => {
  const { referencedResults } = await import("../evals/sanitize-results.js");
  const report = "Final suite: evals/results/2026-09-29T02-51-29-962Z.json\n\n| 00-05-06 | gpt-4.1-mini | code-review |\n";
  const available = ["2026-09-29T02-51-29-962Z.json", "2026-10-05T00-05-06-173Z.json", "2026-10-05T00-09-49-068Z.json", "2026-09-28T00-05-06-111Z.json"];
  assert.deepEqual(referencedResults(report, available), ["2026-09-29T02-51-29-962Z.json", "2026-10-05T00-05-06-173Z.json"]);
});
