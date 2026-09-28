import type { EvalTask } from "../types.js";
import { fail, pass, read, write } from "../helpers.js";

const LINE_COUNT = 137;
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
const CONTENT = Array.from(
  { length: LINE_COUNT },
  (_, i) => `record ${i + 1}: ${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]}`,
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
    return pass();
  },
};
