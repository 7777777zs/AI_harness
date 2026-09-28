import fs from "node:fs";
import type { EvalTask } from "../types.js";
import { exists, fail, isDir, pass } from "../helpers.js";

export const task: EvalTask = {
  id: "shell-tree",
  description: "Create a directory tree with shell commands and report its structure",
  prompt:
    "Using the run_shell tool (not write_file), create the directories project/src/utils and project/tests, " +
    "and an empty file project/README.md. Then list the resulting structure and report it.",
  check(dir, result) {
    for (const d of ["project/src/utils", "project/tests"]) {
      if (!isDir(dir, d)) return fail(`directory ${d} is missing`);
    }
    if (!exists(dir, "project/README.md")) return fail("project/README.md is missing");
    // "empty file": allow a stray newline/space from shell redirection, but no content.
    if (fs.readFileSync(`${dir}/project/README.md`, "utf8").trim() !== "") return fail("project/README.md is not empty");
    const log = fs.readFileSync(result.logFile, "utf8");
    if (!log.includes('"name":"run_shell"')) return fail("run_shell was never used");
    if (!/utils/.test(result.finalText ?? "")) return fail("final answer does not report the structure");
    return pass();
  },
};
