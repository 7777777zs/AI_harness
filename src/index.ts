// CLI entry: npm start -- "your task"
import { runAgent } from "./agent.js";
import { missingEnv } from "./llm/index.js";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// Load .env if present. Variables already set in the environment take precedence.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const task = process.argv.slice(2).join(" ").trim();
if (!task) fail('No task given. Usage: npm start -- "your task"');

const missing = missingEnv();
if (missing) fail(missing);

console.log(`Task: ${task}\nModel: ${process.env.OPENAI_MODEL}`);
const result = await runAgent({ task, cwd: process.cwd() });
if (result.stopReason === "error") {
  console.error(`\nFatal: ${result.error}`);
  process.exitCode = 1;
}
