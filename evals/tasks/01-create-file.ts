import type { EvalTask } from "../types.js";
import { fail, pass, read } from "../helpers.js";

const CONTENT = "Hello, harness! Line two stays here.";

export const task: EvalTask = {
  id: "create-file",
  description: "Create a file with specific content in a nested directory",
  prompt: `Create the file notes/greeting.txt containing exactly this text: ${CONTENT}`,
  check(dir) {
    const content = read(dir, "notes/greeting.txt");
    if (content === null) return fail("notes/greeting.txt was not created");
    if (content.trim() !== CONTENT) return fail(`unexpected content: ${JSON.stringify(content.slice(0, 80))}`);
    return pass();
  },
};
