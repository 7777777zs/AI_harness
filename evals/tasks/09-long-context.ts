import type { EvalTask } from "../types.js";
import { fail, pass, randomCode, write } from "../helpers.js";

const PARTS = 6;
const FILE_CHARS = 40_000;
const SENTENCES = [
  "The warehouse inventory was reconciled against the quarterly shipping manifests.",
  "Several pallets were relabeled after the scanner firmware update last spring.",
  "Operators noted that the northern loading dock closes early on public holidays.",
  "Temperature logs for cold storage were archived according to the retention policy.",
  "A backlog of returns was processed once the new sorting line came online.",
  "Forklift maintenance is scheduled every six weeks unless usage exceeds the threshold.",
];

/** Per-sandbox answer codes, keyed by sandbox dir (safe with concurrency). */
const answers = new Map<string, string>();

function filler(seed: number): string {
  let text = "";
  for (let i = 0; text.length < FILE_CHARS; i++) {
    text += `${SENTENCES[(i + seed) % SENTENCES.length]} (entry ${seed}.${i})\n`;
  }
  return text;
}

export const task: EvalTask = {
  id: "long-context",
  description: `Follow a chain of ${PARTS} files of ~40k chars each (pointer at the END of each file); tight limit forces compaction`,
  prompt:
    "Read start.txt. Each file tells you which file to read next; follow the chain one file at a time " +
    "until you reach the last file, then report the answer code it contains.",
  // The pointer to the next file is the LAST line, so each file has to be read as a whole (a range
  // from the top won't find it). A whole read returns the 10k head+tail view (~2.9k tokens, which
  // includes the last line), under the 25% per-result cap of 16000 (4000 tokens); six reads exceed
  // the compaction budget of 16000 × 0.7 = 11.2k tokens.
  contextLimit: 16_000,
  compactThreshold: 0.7,
  setup(dir) {
    const names = Array.from({ length: PARTS }, (_, i) => (i === 0 ? "start.txt" : `${randomCode("part").toLowerCase()}.txt`));
    const code = randomCode("ANSWER");
    answers.set(dir, code);
    names.forEach((name, i) => {
      const pointer =
        i < PARTS - 1
          ? `End of part ${i + 1} of ${PARTS}. Next file: ${names[i + 1]}\n`
          : `End of part ${i + 1} of ${PARTS}. This is the last file. The answer code is ${code}\n`;
      write(dir, name, `Part ${i + 1} of ${PARTS}.\n` + filler(i) + pointer);
    });
  },
  check(dir, result) {
    const code = answers.get(dir);
    answers.delete(dir);
    if (!code) return fail("setup did not run");
    if (!(result.finalText ?? "").includes(code)) return fail(`final answer does not contain ${code}`);
    if (result.compactions < 1) return fail("answer correct, but compaction was not triggered");
    return pass();
  },
};
