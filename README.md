# AI Harness (MVP)

A minimal CLI agent. You give it a task. It calls an OpenAI model that can use three local tools: `read_file`, `write_file`, and `run_shell`. The harness runs each tool the model asks for, sends the result back, and repeats until the model gives a final answer (max 20 steps).

## Install

Requires Node.js 20.12+. From this repository:

```bash
npm install
npm link
```

`npm link` puts a global `harness` command on your PATH that points at this checkout. It works in bash, PowerShell and cmd. Source edits take effect immediately; there is no build step. To remove the command: `npm unlink -g ai-harness`.

## Configuration

Put your API key and model in `~/.harness/.env` (on Windows, `%USERPROFILE%\.harness\.env`) so `harness` works from any directory:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

Values are resolved in this order, and the first one found wins:
1. Environment variables (`export OPENAI_API_KEY=...` in bash, `$env:OPENAI_API_KEY = "..."` in PowerShell).
2. `~/.harness/.env`.
3. `.env` in this repository (handy while developing; see `.env.example`).

A `.env` in the directory you run `harness` from is **never** read, so a project's own secrets don't leak into the agent. Set `HARNESS_HOME` to use a directory other than `~/.harness`.

## Usage

```bash
cd ~/some/project
harness "list the files here"
harness "add a .gitignore for a Node project"
harness --cwd ~/other/project "summarize README.md"
harness --help
```

- The agent works in the directory you run `harness` from, or in `--cwd <path>` if given. File tools can't reach outside it (see the safety model below), and shell commands start there.
- Nothing is written into your project unless the task asks for it. Logs go to `~/.harness/logs/<timestamp>.jsonl`.
- From inside this repository you can also run `npm start -- "your task"`. Note that `npm start` always runs in the repository root.

Output:

- Each step prints the model's text, every tool call with its arguments (long ones are cut short), and a one-line summary of each result.
- At the end the harness prints the total steps and token usage.
- Each model request and response is appended to the JSONL log.

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
bin/harness.js        Global `harness` entry: registers tsx, runs src/index.ts
src/
├── index.ts          CLI entry: --cwd/--help parsing, env checks, then calls runAgent
├── config.ts         ~/.harness paths and .env loading
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
// Logs default to ~/.harness/logs; pass logDir to change that.
```

Tools are restricted to `cwd`, and shell commands run there. `autoApprove` defaults to `false`; the CLI never sets it.

## Context management

Before each model call, the harness estimates the context size. The starting point is `inputTokens` from the latest API response, plus characters / 4 for messages added since then. When the estimate goes over `CONTEXT_LIMIT × COMPACT_THRESHOLD`, it compacts:

1. **Level 1 (budget-based):**
   - Walking back from the newest, tool results are kept in full until they use `RECENT_BUDGET` tokens.
   - Older results are replaced by a placeholder, e.g. `[Elided: read_file app/agent.py (6,268 chars). Symbols: class InsightAgent: ask, stream, _inputs, _remember. Description: <1–2 sentences>. This is a lossy summary — re-read the file if you need exact code, names, or details.]`.
     - **Symbols** are extracted from Python and JS/TS code with regexes, never written by the model.
     - **Descriptions** come from batched model calls that see each result in full (up to 12,000 chars). A description is dropped (`description_rejected`) if it names something that isn't defined, called or assigned in the original.
     - Descriptions are cached, so no result is described twice. If the call fails, the placeholder keeps just the symbols.
   - **File listings** (`git ls-files`, `ls`, `dir`, `find`, `tree`, or output that is mostly paths) keep their paths, grouped per directory (`app/: agent.py, db.py`). They never get a model description.
   - Results shorter than 1,500 characters, the newest result, and results the model hasn't seen yet are never elided.
   - Only message content changes, so every tool call keeps its result.
2. **Level 2** (only if still over the threshold):
   - Summarizes complete turns older than the last 3 into one message, using a separate model call.
   - The summarizer sees the **original** tool results (kept in memory), not the Level 1 descriptions.
   - It is skipped when the span is under 1,000 tokens.
   - The summary is discarded (`level2_rejected`) unless it saves at least 20% of the span.
   - The system prompt and the original task are always kept.

**Other safeguards:**
- **Nudges** are hints appended to tool results and logged as `nudge`:
  - **Repeats:** from the 2nd identical call (same tool and normalized arguments), a note asks the model to record findings instead of re-reading.
  - **Missing files:** on the first `read_file` of a missing file, a hint tells the model to list the project files instead of guessing.
  - **Notes:** after 3 consecutive tool-calling steps with no reply text, a reminder asks the model to write down its findings. It fires at most once every 3 steps.
- **Long output:** tool output over 10,000 characters keeps the first 6,000 and last 2,000 characters, with a `[... truncated: N chars / M lines omitted (T lines total) ...]` marker in between.
- **Context-length errors:** if the API still returns one, the harness forces compaction and retries once. If that fails too, it stops with `stopReason: "error"`.

Everything is printed (`⟳ Compaction L1: ~6,744 → ~3,973 tokens …`) and logged to the JSONL file: `compaction`, `level2_rejected`, `level2_skipped`, `describe_failed`, `repeated_call`.

| Env var | Default |
|---|---|
| `CONTEXT_LIMIT` | `100000` tokens |
| `COMPACT_THRESHOLD` | `0.7` |
| `RECENT_BUDGET` | 40% of `CONTEXT_LIMIT` (tokens) |

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

Run these from an empty scratch directory (e.g. `mkdir /tmp/harness-try && cd /tmp/harness-try`) so test files don't land in a real project.

1. **Write and read back.** Answer `y` at the prompt; the model should confirm the content.
   ```bash
   harness "Create hello.txt containing 'hello world', then read it back to confirm"
   ```
2. **Shell.** Answer `y`; the model runs `dir` or `ls` and reports a count.
   ```bash
   harness "List the files in the current directory and count them"
   ```
3. **Path restriction.** The tool returns `Error: Path "../outside.txt" is outside the working directory` and the model reports that it can't access it.
   ```bash
   harness "Read ../outside.txt"
   ```
4. **Denial.** Answer `n`; the model gets `User denied this action` and should say it didn't write the file.
   ```bash
   harness "Write notes/todo.md with a short todo list"
   ```
5. **Truncation.** The result summary should show about 10,035 chars and the final answer should mention truncation.
   ```bash
   harness "Write a file big.txt with 20000 'a' characters using a shell command, then read it"
   ```

Then check `~/.harness/logs/` for the matching `.jsonl` file (one line per model call).
