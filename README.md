# AI Harness (MVP)

A minimal CLI agent. You give it a task. It calls an OpenAI model that can use three local tools: `read_file`, `write_file`, and `run_shell`. The harness runs each tool the model asks for, sends the result back, and repeats until the model gives a final answer (max 20 steps).

## Setup

Requires Node.js 20.12+.

```bash
npm install
```

Set your API key and model in a `.env` file in the project root (copy `.env.example`; `.env` is git-ignored):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

Or set them as environment variables, which take precedence over `.env`:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4.1-mini
```

PowerShell:

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_MODEL = "gpt-4.1-mini"
```

## Usage

```bash
npm start -- "your task here"
```

Output:

- Each step prints the model's text, every tool call with its arguments (long ones are cut short), and a one-line summary of each result.
- At the end the harness prints the total steps and token usage.
- Each model request and response is appended to `logs/<timestamp>.jsonl`.

Type-check: `npm run typecheck` (same as `npx tsc --noEmit`).

## Safety model

- **Path restriction:** `read_file` and `write_file` resolve every path against the working directory and reject anything outside it.
- **Confirmation:** `write_file` and `run_shell` show what they are about to do and wait for `y`. Any other input (or a non-interactive stdin) sends `User denied this action` to the model.
- **Shell caveat:** `run_shell` starts in the working directory, but a shell command can still reach any path. The confirmation prompt is the only safeguard, so read commands before approving.
  - It uses `cmd.exe` on Windows and `/bin/sh` elsewhere.
  - Commands time out after 30 s. On Windows, processes the command itself started may keep running after the timeout.
- **Output limit:** Tool output over 10,000 characters is cut off, with a `[truncated, original length N]` note added.
- **Errors don't crash the agent:** tool errors, invalid JSON arguments, and unknown tool names go back to the model as `Error: ...` strings so it can recover.

## Architecture

```
src/
├── index.ts          CLI entry: argv/env checks, then calls runAgent
├── agent.ts          runAgent(): main loop, provider-agnostic (no `openai` import)
├── confirm.ts        Terminal y/N prompt
├── types.ts          Tool / ToolContext types
├── llm/
│   ├── types.ts      LLMClient interface, Message, ToolCall, LLMResponse, ContextLengthError
│   ├── index.ts      createClientFromEnv(): the one place that picks a provider
│   └── openai.ts     OpenAI Chat Completions adapter
├── context/
│   ├── tokens.ts     Token estimate (API ground truth + chars/4 for new messages)
│   ├── turns.ts      Turn-group splitting and tool-call pairing validation
│   ├── compact.ts    Level 1 (elide old tool results) and Level 2 (summarize)
│   └── summarize.ts  LLM-backed summarizer
└── tools/
    ├── index.ts      Tool registry
    ├── util.ts       Path restriction, arg validation, truncation
    ├── readFile.ts
    ├── writeFile.ts
    └── runShell.ts
test/                 Unit tests (node:test)
evals/                Eval suite: tasks/, run.ts, results/ (gitignored)
```

`agent.ts` only uses the `LLMClient` interface and the types in `llm/types.ts`. Everything OpenAI-specific lives in `llm/openai.ts`: the `tool_calls` format, `role: "tool"` messages, `tool_call_id`, JSON argument parsing, and mapping context-length errors to `ContextLengthError`.

To add another provider (e.g. Anthropic), write `llm/anthropic.ts` implementing `LLMClient`. It needs to convert internal `Message`s to that provider's format (for Anthropic, tool results go into a `user` message as `tool_result` blocks) and parse responses back into `LLMResponse`. Then pick it in `llm/index.ts`. `agent.ts` does not change.

### Programmatic use

```ts
import { runAgent } from "./src/agent.js";

const result = await runAgent({ task: "…", cwd: "/path/to/sandbox", autoApprove: false });
// result: { finalText, steps, usage, stopReason: "done" | "max_steps" | "error", error?, durationMs, compactions, logFile }
```

Tools are restricted to `cwd`, and shell commands run there. `autoApprove` defaults to `false`; the CLI never sets it.

## Context management

Before each model call, the harness estimates the context size. The starting point is `inputTokens` from the latest API response, plus characters / 4 for messages added since then. When the estimate goes over `CONTEXT_LIMIT × COMPACT_THRESHOLD`, it compacts:

1. **Level 1:** replaces the content of tool results older than the last 3 turns with a placeholder like `[Tool result elided to save context: read_file, 24,310 chars]`. No messages are removed.
2. **Level 2** (only if still over the threshold): summarizes everything older than the last 3 turns into a single message, using a separate model call. The system prompt and the original task are always kept. Only complete turns (an assistant message together with all its tool results) are removed, so every tool call keeps its result.

Each compaction is printed (`⟳ Compaction L1: ~11,670 → ~6,683 tokens …`) and written to the JSONL log as `"type":"compaction"`. If the API still returns a context-length error, the harness forces compaction and retries once. If that fails too, it stops with `stopReason: "error"`.

| Env var | Default |
|---|---|
| `CONTEXT_LIMIT` | `100000` tokens |
| `COMPACT_THRESHOLD` | `0.7` |

## Tests

```bash
npm test
```

Unit tests for compaction and the agent loop. They use `node:test` and a fake LLM client, so no API calls are made.

## Evals

```bash
npm run eval
npm run eval -- --task long-context --verbose
npm run eval -- --runs 3 --concurrency 3
```

Each task runs in a fresh temp directory with `autoApprove: true`. It is then graded by deterministic code, which checks files on disk where possible.

Options:
- `--task <id>`: run one task.
- `--runs N`: repeat each task N times.
- `--concurrency N`: run N jobs in parallel.
- `--keep`: keep the temp directories.
- `--verbose`: show the agent's output.

The runner prints a summary table and saves full results to `evals/results/<timestamp>.json`. It also lists any tasks whose pass rate changed since the previous results file. Per-run agent logs go to `evals/results/logs/`.

The `long-context` task sets a context limit of 14,000 tokens, so compaction is triggered. It fails if no compaction happens.

To add a task, create `evals/tasks/NN-name.ts` exporting an `EvalTask` (see `evals/types.ts`) and add it to `evals/tasks/index.ts`.

## Manual test cases

1. **Write and read back.** Answer `y` at the prompt; the model should confirm the content.
   ```bash
   npm start -- "Create hello.txt containing 'hello world', then read it back to confirm"
   ```
2. **Shell.** Answer `y`; the model runs `dir` or `ls` and reports a count.
   ```bash
   npm start -- "List the files in the current directory and count them"
   ```
3. **Path restriction.** The tool returns `Error: Path "../outside.txt" is outside the working directory` and the model reports that it can't access it.
   ```bash
   npm start -- "Read ../outside.txt"
   ```
4. **Denial.** Answer `n`; the model gets `User denied this action` and should say it didn't write the file.
   ```bash
   npm start -- "Write notes/todo.md with a short todo list"
   ```
5. **Truncation.** The result summary should show about 10,035 chars and the final answer should mention truncation.
   ```bash
   npm start -- "Write a file big.txt with 20000 'a' characters using a shell command, then read it"
   ```

Then check `logs/` for the matching `.jsonl` file (one line per model call).
