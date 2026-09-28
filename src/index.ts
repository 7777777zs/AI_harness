// CLI entry: `harness [--cwd <path>] "your task"` (or `npm start -- "your task"` in this repo)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./agent.js";
import { harnessHome, loadEnv, logsDir } from "./config.js";
import { missingEnv } from "./llm/index.js";

const USAGE = `Usage: harness [--cwd <path>] "your task"

Options:
  --cwd <path>  Directory the agent works in (default: the current directory)
  -h, --help    Show this help

Configuration is read from the environment, then ${path.join(harnessHome(), ".env")}.
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

console.log(`Task: ${task}\nModel: ${process.env.OPENAI_MODEL}\nDirectory: ${cwd}`);
const result = await runAgent({ task, cwd, logDir: logsDir() });
if (result.stopReason === "error") {
  console.error(`\nFatal: ${result.error}`);
  process.exitCode = 1;
}
