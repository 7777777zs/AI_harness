import type { EvalTask } from "../types.js";
import { fail, lines, pass, read, write } from "../helpers.js";

const TARGET = "max_connections = 250";
const REPLACEMENT = "max_connections = 500";

/** A deterministic ~20k-char config file with one target line and several look-alike decoys. */
function buildConfig(): string {
  let seed = 1234567;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words = ["cache", "queue", "worker", "session", "upload", "search", "report", "audit", "metrics", "mail"];
  const out: string[] = ["# server.conf: generated configuration", "# edit with care", ""];
  const section = (name: string, extra: string[] = []) => {
    out.push(`# ==== ${name} ====`, `[${name}]`);
    for (let i = 0; i < 24; i++) {
      const w = words[rand(words.length)]!;
      const key = `${w}_${["timeout_ms", "retries", "batch_size", "ttl_s", "limit"][rand(5)]}_${i}`;
      out.push(`${key} = ${rand(5000)}`);
    }
    out.push(...extra, "");
  };
  for (let s = 0; s < 12; s++) section(`service_${s}`);
  section("network", ["max_connections_per_ip = 250", "# max_connections was raised to 250 in 2023"]);
  section("database", ["pool_max_connections = 250", TARGET, "max_connections_timeout_ms = 250"]);
  for (let s = 12; s < 20; s++) section(`service_${s}`);
  let text = out.join("\n") + "\n";
  for (let s = 20; text.length < 20_000; s++) {
    section(`service_${s}`);
    text = out.join("\n") + "\n";
  }
  return text;
}

const ORIGINAL = buildConfig();

export const task: EvalTask = {
  id: "large-file-edit",
  description: "Change one value in a ~20k-char config file; nothing else may change",
  prompt:
    "In server.conf, change the max_connections setting in the [database] section from 250 to 500. " +
    "Change only that one setting (not similarly named keys or comments) and do not change anything else in the file.",
  setup(dir) {
    write(dir, "server.conf", ORIGINAL);
  },
  check(dir) {
    const content = read(dir, "server.conf");
    if (content === null) return fail("server.conf is missing");
    const before = lines(ORIGINAL);
    const after = lines(content);
    if (after.length !== before.length) return fail(`expected ${before.length} lines, found ${after.length}`);
    const changed = before.flatMap((l, i) => (after[i] !== l ? [i] : []));
    const target = before.indexOf(TARGET);
    if (changed.length === 0) return fail("the file was not changed");
    const wrong = changed.filter((i) => i !== target);
    if (wrong.length) {
      const i = wrong[0]!;
      return fail(`${wrong.length} other line(s) changed, e.g. line ${i + 1}: ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`);
    }
    if (after[target]!.trimEnd() !== REPLACEMENT) return fail(`line ${target + 1} is ${JSON.stringify(after[target])}, expected ${JSON.stringify(REPLACEMENT)}`);
    return pass();
  },
};
