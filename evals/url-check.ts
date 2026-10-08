// First-step check for web tasks: does the model open the task's URL with an MCP tool, or refuse
// ("I cannot access local URLs"), look for it as a file, or call only MCP tools that don't load it
// (list_pages, a snapshot of the blank tab)? Sends only the first request of each web task, built
// from the current system prompt, the [Harness status] line and the chrome-devtools tool definitions
// in evals/fixtures/ (no browser, no MCP server). Each call gets a random working directory and port:
// gpt-4.1-mini's choice is close to deterministic for one exact prompt but flips with such details,
// so a rate is only meaningful across many variants.
//   npx tsx evals/url-check.ts [--runs N] [--task id]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { baseSystemPrompt, mcpToolsNote, UNTRUSTED_CONTENT_NOTE } from "../src/agent.js";
import { loadEnv } from "../src/config.js";
import { estimateText } from "../src/context/tokens.js";
import { createClientFromEnv, missingEnv } from "../src/llm/index.js";
import { withRetry } from "../src/llm/retry.js";
import type { ToolCall, ToolDefinition } from "../src/llm/types.js";
import { ResultPages } from "../src/mcp/resultPages.js";
import { mentionsUrl, taskUrls, withUnopenedUrls } from "../src/taskUrls.js";
import { tools as builtinTools } from "../src/tools/index.js";
import { tasks } from "./tasks/index.js";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "20" }, task: { type: "string" } } });
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer`);

loadEnv();
const missing = missingEnv();
if (missing) throw new Error(missing);
const client = withRetry(createClientFromEnv());

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "chrome-devtools-tools.json");
const mcpTools: ToolDefinition[] = JSON.parse(fs.readFileSync(fixture, "utf8"));
const readToolResult = new ResultPages().tool(() => ({ maxChars: 10_000, maxTokens: 25_000, tokensOf: estimateText }));
const toolDefs: ToolDefinition[] = [...builtinTools, ...mcpTools, readToolResult].map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

const webTasks = tasks.filter((t) => typeof t.prompt === "function" && (!args.task || t.id === args.task));
if (webTasks.length === 0) throw new Error(`no web task${args.task ? ` "${args.task}"` : ""}`);

let inputTokens = 0;
let outputTokens = 0;
let totalMisses = 0;
for (const task of webTasks) {
  // opened: an MCP call with the task URL itself in its arguments (e.g. new_page, navigate_page).
  // otherMcp: MCP calls that don't load it (e.g. only list_pages, or a snapshot of the blank tab).
  const counts = { opened: 0, otherMcp: 0, local: 0, text: 0 };
  const examples: string[] = [];
  await Promise.all(
    Array.from({ length: runs }, async () => {
      const cwd = path.join(os.tmpdir(), `ai-harness-eval-${Math.random().toString(36).slice(2, 8)}`, "work");
      const baseUrl = `http://127.0.0.1:${49152 + Math.floor(Math.random() * 16000)}`;
      const system = baseSystemPrompt(cwd, "win32") + mcpToolsNote(mcpTools) + UNTRUSTED_CONTENT_NOTE;
      const user = (task.prompt as (web: { baseUrl: string }) => string)({ baseUrl });
      // The harness's first request ends with the [Harness status] line naming the unopened task URL (N5).
      const urls = taskUrls(user);
      const statusText = withUnopenedUrls(null, urls.map(String));
      const status = statusText ? [{ role: "user" as const, content: statusText }] : [];
      const r = await client.chat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
          ...status,
        ],
        toolDefs,
      );
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
      const names = r.toolCalls.map((c) => c.name);
      const opened = (args: ToolCall["args"]) => urls.some((url) => mentionsUrl(args, url));
      if (r.toolCalls.some((c) => c.name.startsWith("mcp__") && opened(c.args))) counts.opened++;
      else if (names.length) {
        if (names.some((n) => n.startsWith("mcp__"))) counts.otherMcp++;
        else counts.local++;
        examples.push(`tools: ${names.join(", ")}`);
      } else {
        counts.text++;
        examples.push(`text: ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }),
  );
  totalMisses += runs - counts.opened;
  console.log(
    `${task.id.padEnd(18)} opened the URL ${counts.opened}/${runs}  other MCP only ${counts.otherMcp}  ` +
      `local tools only ${counts.local}  refused ${counts.text}`,
  );
  for (const e of examples.slice(0, 3)) console.log(`  ${e}`);
}
// gpt-4.1-mini list prices per million tokens; only an estimate for other models.
const cost = (inputTokens * 0.4 + outputTokens * 1.6) / 1e6;
console.log(`\nMissed ${totalMisses}/${runs * webTasks.length} first steps. ~${inputTokens} input tokens, ~$${cost.toFixed(3)} at gpt-4.1-mini prices.`);
