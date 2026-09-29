// Deterministic long-context integration test (replaces the compaction requirement of the
// real-model long-context eval): a scripted model reads several large files in full, one after
// another, under a tight context limit. No API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import { runAgent } from "../src/agent.js";
import { STATUS_PREFIX } from "../src/context/coverage.js";
import { estimateTokens, estimateToolDefs } from "../src/context/tokens.js";
import { validatePairing } from "../src/context/turns.js";
import { SUMMARY_PREFIX } from "../src/context/compact.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const PARTS = 8;
const names = Array.from({ length: PARTS }, (_, i) => `docs/part${i + 1}.txt`);

/** ~9k chars per file: under the 10k tool-output truncation, so every read returns the whole file. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-lc-"));
  created.push(dir);
  fs.mkdirSync(path.join(dir, "docs"));
  names.forEach((name, i) => {
    let body = `Part ${i + 1} of ${PARTS}.\n`;
    for (let k = 0; body.length < 9_000; k++) body += `Record ${i}.${k}: the warehouse was reconciled against the manifests.\n`;
    body += i < PARTS - 1 ? `Next file: ${names[i + 1]}\n` : "The answer code is ANSWER-LC-42\n";
    fs.writeFileSync(path.join(dir, name), body);
  });
  fs.writeFileSync(path.join(dir, "README.md"), "# Chain\nStart with docs/part1.txt.\n");
  return dir;
}

test("long context: reading large files in full triggers Level 1 and Level 2, keeps pairing and the pinned file list", async () => {
  const dir = fixture();
  const requests: Message[][] = [];
  const reply = (text: string | null, toolCalls: LLMResponse["toolCalls"], msgs: Message[], tools: unknown[]): LLMResponse => ({
    text,
    toolCalls,
    // Realistic usage, so the tracker's ground truth and calibration behave as with a real API.
    usage: { inputTokens: estimateTokens(msgs) + estimateToolDefs(tools as never), outputTokens: 50 },
    raw: null,
  });
  const client: LLMClient = {
    async chat(msgs, tools) {
      if (tools.length === 0) {
        // Compaction calls: Level 1 descriptions (JSON by id) or a Level 2 summary.
        const body = msgs.at(-1)!.content ?? "";
        const ids = [...body.matchAll(/### id: (\S+)/g)].map((m) => m[1]!);
        if (ids.length) return reply(JSON.stringify(Object.fromEntries(ids.map((id) => [id, "A chain file of warehouse records."]))), [], msgs, tools);
        return reply("Assistant notes: parts read so far form a chain.\n\nRemaining work:\n- Finish the chain.", [], msgs, tools);
      }
      requests.push(structuredClone(msgs));
      // Count calls, not assistant messages: Level 2 removes older assistant messages from history.
      const n = requests.length - 1;
      if (n === 0) return reply(null, [{ id: "ls", name: "list_dir", args: { path: ".", depth: 2 } }], msgs, tools);
      if (n <= PARTS) {
        // Detailed notes (~3k chars) that Level 1 can't elide: once enough accumulate, Level 2 is needed.
        const notes = `Notes after step ${n}: ` + "the previous part points to the next one; records are consistent. ".repeat(45);
        return reply(notes, [{ id: `r${n}`, name: "read_file", args: { path: names[n - 1]! } }], msgs, tools);
      }
      return reply("The answer code is ANSWER-LC-42.", [], msgs, tools);
    },
  };

  const result = await runAgent({
    task: "Follow the chain of files starting at docs/part1.txt and report the answer code.",
    cwd: dir,
    client,
    quiet: true,
    contextLimit: 16_000,
    compactThreshold: 0.7,
    coverageCheck: false,
  });

  // The run finishes normally with the right answer.
  assert.equal(result.stopReason, "done");
  assert.match(result.finalText!, /ANSWER-LC-42/);
  // Each file was read in full (no line ranges, not truncated).
  for (const req of requests) {
    for (const m of req) if (m.role === "tool" && m.name === "read_file") assert.ok(!m.content.includes("[Truncated at line"));
  }
  // Compaction happened at both levels.
  assert.ok(result.compactionStats.level1 >= 1, `Level 1 ran (${result.compactionStats.level1})`);
  assert.ok(result.compactionStats.level2Accepted >= 1, `Level 2 ran (${result.compactionStats.level2Accepted})`);
  assert.ok(requests.some((req) => req.some((m) => m.role === "user" && m.content?.startsWith(SUMMARY_PREFIX))), "a summary was sent");
  // Tool-call pairing is valid in every request that was sent (the status block is not part of history).
  for (const [i, req] of requests.entries()) {
    const history = req.at(-1)?.content?.startsWith(STATUS_PREFIX) ? req.slice(0, -1) : req;
    assert.equal(validatePairing(history), null, `request ${i}`);
  }
  // The listing result itself is gone from history by the end, but the pinned file list survives.
  const last = requests.at(-1)!;
  assert.ok(!last.some((m) => m.role === "tool" && m.toolCallId === "ls"), "the list_dir result was compacted away");
  const status = last.at(-1)!;
  assert.ok(status.content!.startsWith(STATUS_PREFIX));
  for (const name of [...names, "README.md"]) assert.ok(status.content!.includes(path.posix.basename(name)), name);
  assert.match(status.content!, /Read: 8 \/ Not yet read: 1\nNot yet read: \.\/: README\.md$/);
  // Every request stayed within the context limit.
  for (const req of requests) assert.ok(estimateTokens(req) <= 16_000, `request ~${estimateTokens(req)} tokens`);
});
