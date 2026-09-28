import type { EvalTask } from "../types.js";
import { fail, pass, read, write } from "../helpers.js";

const LINE_COUNT = 137;
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
// No digits in the fixture: the count can't be copied from a line label like "record 137".
const CONTENT = Array.from(
  { length: LINE_COUNT },
  (_, i) => `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} ${WORDS[(i * 5 + 1) % WORDS.length]}`,
).join("\n") + "\n";

export const task: EvalTask = {
  id: "count-lines",
  description: "Count the lines in a fixture file and report the number",
  prompt: "How many lines does data.txt contain? Report the exact number.",
  setup(dir) {
    write(dir, "data.txt", CONTENT);
  },
  check(dir, result) {
    if (read(dir, "data.txt") !== CONTENT) return fail("data.txt was modified");
    const text = result.finalText ?? "";
    if (!new RegExp(`\\b${LINE_COUNT}\\b`).test(text)) {
      return fail(`final answer does not contain ${LINE_COUNT}: ${JSON.stringify(text.slice(0, 120))}`);
    }
    // Hedged answers ("136 or 137", "137 or 138") are not a count.
    if (/\b(136|138)\b/.test(text)) return fail(`final answer also mentions an off-by-one count: ${JSON.stringify(text.slice(0, 120))}`);
    return pass();
  },
};
