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
  description: `Follow a chain of ${PARTS} files of ~40k chars each; low context limit forces compaction`,
  prompt:
    "Read start.txt. Each file tells you which file to read next; follow the chain one file at a time " +
    "until you reach the last file, then report the answer code it contains. Only the first lines of each file matter.",
  // Each read returns ~10k chars (~2.5k tokens) after tool-output truncation, so the
  // budget of 14000 × 0.7 ≈ 9.8k tokens is exceeded after about four reads.
  contextLimit: 14_000,
  compactThreshold: 0.7,
  setup(dir) {
    const names = Array.from({ length: PARTS }, (_, i) => (i === 0 ? "start.txt" : `${randomCode("part").toLowerCase()}.txt`));
    const code = randomCode("ANSWER");
    answers.set(dir, code);
    names.forEach((name, i) => {
      const header =
        i < PARTS - 1
          ? `Part ${i + 1} of ${PARTS}. Next file: ${names[i + 1]}\n`
          : `Part ${i + 1} of ${PARTS}. This is the last file. The answer code is ${code}\n`;
      write(dir, name, header + filler(i));
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
