import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

const MARKER = "BLUE-HERON-7731";
const TARGET = "inventory-c.txt";
const FILES = ["inventory-a.txt", "inventory-b.txt", TARGET, "inventory-d.txt", "shipping.txt", "notes.txt"];

export const task: EvalTask = {
  id: "find-string",
  description: "Find which of several files contains a given string",
  prompt: `Which file in the current directory contains the string "${MARKER}"? Answer with the file name.`,
  setup(dir) {
    for (const [i, name] of FILES.entries()) {
      const body = Array.from({ length: 40 }, (_, j) => `item ${i}-${j}: code GREEN-OWL-${1000 + i * 40 + j}`);
      if (name === TARGET) body.splice(23, 0, `special item: code ${MARKER}`);
      write(dir, name, body.join("\n") + "\n");
    }
  },
  check(_dir, result) {
    const text = result.finalText ?? "";
    if (!text.includes(TARGET)) return fail(`final answer does not name ${TARGET}: ${JSON.stringify(text.slice(0, 120))}`);
    return pass();
  },
};
