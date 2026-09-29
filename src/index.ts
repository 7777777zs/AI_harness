// CLI entry: `harness [options] "your task"` (or `npm start -- "your task"` in this repo)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./agent.js";
import { ConfigError, harnessHome, loadEnv, logsDir, resolveConfig, type SettingOverrides } from "./config.js";
import { missingEnv } from "./llm/index.js";

const USAGE = `Usage: harness [options] "your task"

Options:
  --cwd <path>                Directory the agent works in (default: the current directory)
  --context-limit <tokens>    CONTEXT_LIMIT      (default 100000, min 2000)
  --compact-threshold <0-1>   COMPACT_THRESHOLD  (default 0.7, range 0.1-0.95)
  --recent-budget <tokens>    RECENT_BUDGET      (default 40% of the context limit)
  --compact-model <model>     COMPACT_MODEL      (default: the main model)
  --coverage-check <on|off>   COVERAGE_CHECK     (default on)
  --coverage-footer <on|off>  COVERAGE_FOOTER    (default on)
  --max-steps <n>             MAX_STEPS          (default 20)
  -h, --help                  Show this help

Settings precedence: these flags > environment variables > ${path.join(harnessHome(), ".env")} > defaults.
Logs are written to ${logsDir()}.`;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "context-limit": { type: "string" },
      "compact-threshold": { type: "string" },
      "recent-budget": { type: "string" },
      "compact-model": { type: "string" },
      "coverage-check": { type: "string" },
      "coverage-footer": { type: "string" },
      "max-steps": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
}

if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}

const task = args.positionals.join(" ").trim();
if (!task) fail(`No task given.\n\n${USAGE}`);

const cwd = path.resolve(args.values.cwd ?? process.cwd());
if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) fail(`--cwd is not a directory: ${cwd}`);

loadEnv();
const missing = missingEnv();
if (missing) fail(`${missing} Set it in the environment or in ${path.join(harnessHome(), ".env")}.`);

// Flags are validated by the same rules as env/.env values (resolveConfig throws ConfigError).
const flag = (name: string) => args.values[name as keyof typeof args.values] as string | undefined;
const num = (name: string) => {
  const v = flag(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name}="${v}" is not a number`);
  return n;
};
const onOff = (name: string) => {
  const v = flag(name)?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === "on" || v === "off") return v === "on";
  fail(`--${name} must be on or off`);
};
const overrides: SettingOverrides = {};
const set = <K extends keyof SettingOverrides>(key: K, value: SettingOverrides[K] | undefined) => {
  if (value !== undefined) overrides[key] = value;
};
set("contextLimit", num("context-limit"));
set("compactThreshold", num("compact-threshold"));
set("recentBudget", num("recent-budget"));
set("compactModel", flag("compact-model"));
set("coverageCheck", onOff("coverage-check"));
set("coverageFooter", onOff("coverage-footer"));
set("maxSteps", num("max-steps"));
try {
  resolveConfig(overrides); // fail fast, before any output, on invalid settings from any source
} catch (err) {
  if (err instanceof ConfigError) fail(`Invalid configuration: ${err.message}`);
  throw err;
}

console.log(`Task: ${task}\nModel: ${process.env.OPENAI_MODEL}\nDirectory: ${cwd}`);
const result = await runAgent({ task, cwd, logDir: logsDir(), ...overrides });
if (result.stopReason === "error") {
  console.error(`\nFatal: ${result.error}`);
  process.exitCode = 1;
}
