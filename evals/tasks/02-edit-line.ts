import type { EvalTask } from "../types.js";
import { fail, lines, pass, read, write } from "../helpers.js";

const ORIGINAL = [
  "# service settings",
  "name=inventory-api",
  "host=0.0.0.0",
  "port=8080",
  "timeout=30",
  "retries=3",
  "log_level=info",
  "cache_ttl=300",
  "feature_flags=search,export",
  "owner=platform-team",
];

export const task: EvalTask = {
  id: "edit-line",
  description: "Change one line of a config file without touching the others",
  prompt: "In settings.ini, change the timeout from 30 to 60. Do not change anything else in the file.",
  setup(dir) {
    write(dir, "settings.ini", ORIGINAL.join("\n") + "\n");
  },
  check(dir) {
    const content = read(dir, "settings.ini");
    if (content === null) return fail("settings.ini is missing");
    const actual = lines(content);
    const expected = ORIGINAL.map((l) => (l === "timeout=30" ? "timeout=60" : l));
    if (actual.length !== expected.length) return fail(`expected ${expected.length} lines, found ${actual.length}`);
    const diff = expected.findIndex((l, i) => actual[i]!.trimEnd() !== l);
    if (diff !== -1) return fail(`line ${diff + 1} is ${JSON.stringify(actual[diff])}, expected ${JSON.stringify(expected[diff])}`);
    return pass();
  },
};
