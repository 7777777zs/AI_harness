# AI Harness (MVP)

A minimal CLI agent. You give it a task. It calls an OpenAI model that can use local tools. The harness runs each tool the model asks for, sends the result back, and repeats until the model gives a final answer (max 20 steps).

| Tool | What it does | Confirmation |
|---|---|---|
| `read_file` | Read a file; optional `offset`/`limit` for a numbered line range | no |
| `list_dir` | Directory tree (`depth` 1–5) with sizes | no |
| `glob` | Find files by pattern, e.g. `**/*.py` | no |
| `grep` | Regex search, `path:line: text`, optional `glob` filter and context lines | no |
| `edit_file` | Exact, unique `old_str` → `new_str` replacement (or `replace_all`), shows a diff | yes |
| `write_file` | Create or overwrite a file | yes |
| `run_shell` | Run a command (30 s timeout) | yes |

`list_dir`, `glob` and `grep` are implemented in Node, so they behave the same on Windows, macOS and Linux. They respect `.gitignore` and always skip `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist` and `build`. All tool paths are relative to the working directory and use forward slashes.

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

Every setting can go in the same file. `.env.example` lists them all with their defaults.

| Setting | Default | Meaning |
|---|---|---|
| `CONTEXT_LIMIT` | `100000` | Context window budget in tokens (min 2000) |
| `COMPACT_THRESHOLD` | `0.7` | Share of the limit at which compaction starts (0.1–0.95) |
| `RECENT_BUDGET` | 40% of the limit | Tokens of recent tool results kept in full by compaction |
| `COMPACT_MODEL` | the main model | Model for compaction calls (file descriptions, summaries) |
| `COVERAGE_CHECK` | `on` | Ask once to cover unread files before accepting a whole-project answer |
| `COVERAGE_FOOTER` | `on` | Append the harness-computed coverage footer to final answers |
| `MAX_STEPS` | `20` | Maximum agent steps per task |
| `SKILLS` | `on` | The skills system (see [Skills](#skills)) |

Values are resolved in this order, and the first one found wins:
1. Explicit options: `runAgent({...})` options, or the CLI flags `--context-limit`, `--compact-threshold`, `--recent-budget`, `--compact-model`, `--coverage-check`, `--coverage-footer`, `--max-steps`, `--no-skills`.
2. Environment variables (`export CONTEXT_LIMIT=8000` in bash, `$env:CONTEXT_LIMIT = "8000"` in PowerShell).
3. `~/.harness/.env`.
4. `.env` in this repository (handy while developing).
5. Built-in defaults.

Invalid values stop the harness with a clear message instead of falling back silently. Examples are a non-numeric `CONTEXT_LIMIT`, a `CONTEXT_LIMIT` below 2000, and a `COMPACT_THRESHOLD` outside 0.1–0.95. At startup, the terminal and the `run_start` log entry show each setting's effective value and its source (`option`, `env`, `.env` or `default`).

A `.env` in the directory you run `harness` from is **never** read, so a project's own secrets don't leak into the agent. Set `HARNESS_HOME` to use a directory other than `~/.harness`. The eval runner passes every setting explicitly, so your `.env` can't change eval behaviour.

## Usage

```bash
cd ~/some/project
harness "list the files here"
harness "add a .gitignore for a Node project"
harness --cwd ~/other/project "summarize README.md"
harness --mcp chrome-devtools "open http://localhost:3000 and tell me what the page says"
harness --no-mcp "run the tests"
harness --skill code-review "review my uncommitted changes"
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

- **Path restriction:** every file tool resolves paths against the working directory and rejects anything outside it. Symlinks and Windows junctions are resolved too, so a link inside the working directory can't be used to reach files outside it.
- **Confirmation:** `edit_file`, `write_file` and `run_shell` show what they are about to do and wait for `y`. Any other input (or a non-interactive stdin) sends `User denied this action` to the model.
- **Shell caveat:** `run_shell` starts in the working directory, but a shell command can still reach any path. The confirmation prompt is the only safeguard, so read commands before approving.
  - It uses `cmd.exe` on Windows and `/bin/sh` elsewhere.
  - Commands time out after 30 s. On Windows, processes the command itself started may keep running after the timeout.
- **Output limit:** tool output over 10,000 characters keeps the first 6,000 and last 2,000 characters, with a `[... truncated: N chars / M lines omitted ...]` marker in between.
- **Errors don't crash the agent:** tool errors, invalid JSON arguments, and unknown tool names go back to the model as `Error: ...` strings so it can recover.
- **MCP content is untrusted:** see the next section.

## MCP servers

The harness can use tools from [MCP](https://modelcontextprotocol.io) servers (stdio only). Servers are configured in `~/.harness/mcp.json`, in the common `mcpServers` format plus a few harness fields:

| Field | Default | Meaning |
|---|---|---|
| `command`, `args`, `env` | – | How to start the server. `npx` works on Windows too. `env` is added to a minimal environment, so your API key is not passed on. |
| `enabled` | `true` | `false` skips the server unless it is named with `--mcp`. |
| `includeTools` / `excludeTools` | all / none | Which of the server's tools the model sees. |
| `autoApproveTools` | none | Tools that run without confirmation. **Every other MCP tool asks first.** |
| `hideParams` | none | `{ "<tool>": ["<param>"] }`: removed from the tool's schema, and calls that pass them anyway are rejected. |
| `callTimeoutMs` | 60000 | Per tool call. |
| `startupTimeoutMs` | 30000 | Start + handshake + tool listing. |

- **Flags:** `--mcp a,b` uses only those servers; `--no-mcp` uses none. Invalid configuration (bad JSON, unknown keys, out-of-range timeouts, unknown `--mcp` names) stops the harness at startup with a clear message.
- **Tool names:** tools appear to the model as `mcp__<server>__<tool>`. Names are limited to `[a-zA-Z0-9_-]`, 64 characters; longer names are shortened with a hash. Two tools mapping to the same name is an error.
- **Startup:** servers start in parallel when the run starts. A server that fails to start is reported and skipped; the run continues without it. The `run_start` log entry lists each server, its tools and which are auto-approved.
- **Shutdown:** when the run ends (normally, with an error, or on Ctrl+C), each server's whole process tree is shut down. Its stdin is closed first so it can close its browser cleanly; whatever is still running after 3 s is killed.
- **Results:**
  - Text is passed on as-is. Images become a note like `[image omitted: image/png, 1280x720, …]`, because tool messages can't carry images.
  - Results longer than one page (10,000 characters, or less for small context limits) are split into pages kept in memory. The model sees the first page and can read the rest with the built-in `read_tool_result` tool, by offset or by searching with `pattern`.
  - Size caps, compaction and logging apply as for every other tool.

### Untrusted content

Everything an MCP tool returns, such as a web page, is treated as data, not instructions:
- The system prompt says so.
- Every MCP result is wrapped in an `[Untrusted content from …]` / `[End of untrusted content …]` pair.
- **Guard:** after the model has received MCP content, its next `run_shell`, `write_file` or `edit_file` asks for confirmation **even with auto-approve**. Each such call is logged as `post_untrusted_action`, and the eval runner always denies them.

### Chrome DevTools MCP

[`mcp.example.json`](mcp.example.json) configures Google's `chrome-devtools-mcp`. Copy it to `~/.harness/mcp.json`.

- **Profile:** it uses the server's default *dedicated* browser profile, which is logged into nothing.
- **`--autoConnect`:** attaches to your own running Chrome instead. The agent could then act inside your logged-in sessions (mail, banking, admin consoles), so it is not recommended for general use.
- **Other flags:** `--headless` runs without a window. `--isolated` uses a fresh temporary profile each time; the evals use both.
- **Why not `--slim`:** slim mode has only three tools: `navigate`, `evaluate` (runs arbitrary JavaScript in the page) and `screenshot` (returns a file path). It has no text snapshot, so reading a page would require `evaluate`. The example uses full mode narrowed with `includeTools` instead.

| Tool | Auto-approved | Why |
|---|---|---|
| `list_pages` | yes | Lists open tabs; read-only. |
| `select_page` | yes | Chooses the tab later calls use; changes nothing on the page. |
| `new_page` | yes | Opens a URL in a new tab, like following a link. |
| `navigate_page` | yes, with `initScript` hidden | URL / back / forward / reload. `initScript` would run JavaScript on the page, so it is removed. |
| `take_snapshot` | yes, with `filePath` hidden | Text (accessibility-tree) snapshot of the page. `filePath` would write a file anywhere on disk, so it is removed. |
| `wait_for` | yes | Waits for text to appear; read-only. |
| `click`, `fill`, `press_key` | no | Interact with the page (submit forms, trigger actions). |
| `evaluate_script` | no | Runs arbitrary JavaScript in the page. |

All other tools of the server (performance traces, heap snapshots, extensions, file uploads, network request bodies saved to disk, …) are not exposed. Before a public page's instructions reach a shell or a file, the guard above asks you.

## Skills

A **skill** is a reusable set of instructions for one kind of task, loaded only when a task needs it. The model sees each skill's name and description; when a task matches, it calls `load_skill` and gets the full instructions.

| Skill | What it does | Notes |
|---|---|---|
| [`codebase-onboarding`](skills/codebase-onboarding/SKILL.md) | Maps an unfamiliar project: module map, the main flow traced hop by hop, how to run it, and what was not examined | read-only |
| [`bugfix-with-test`](skills/bugfix-with-test/SKILL.md) | Reproduces the bug with a failing test, makes the minimal fix, and never edits existing tests | |
| [`web-research`](skills/web-research/SKILL.md) | Answers from web pages with a URL for every claim, cross-checks sources, and reports conflicts | needs the `chrome-devtools` MCP server |
| [`code-review`](skills/code-review/SKILL.md) | Reviews a diff against a [checklist](skills/code-review/checklist.md) and reports findings by severity with `file:line` and a fix | read-only |

### Format

A skill is a directory with a `SKILL.md` and, optionally, supporting files (checklists, templates):

```markdown
---
name: code-review              # required: ^[a-z0-9-]{1,40}$, equal to the directory name
description: Review code changes and report findings by severity… Use when asked to review …
                               # required, ≤ 300 characters: WHAT it does and WHEN to use it
requires:                      # optional: the skill is unavailable without these
  mcp: [chrome-devtools]       #   connected MCP servers
  tools: [run_shell]           #   tools
readOnly: true                 # optional, default false
---
# Instructions (Markdown)…
```

**Locations:**
- Bundled skills live in this repository's [`skills/`](skills/); your own go in `~/.harness/skills/<name>/SKILL.md`.
- On a name clash your skill wins, with a logged warning.
- A skill with invalid frontmatter is skipped with a warning naming the problem; the run continues.

### How skills are used

- **Listing:** the system prompt lists every skill as `name: description`. The `load_skill` tool description lists them as well, because that is where the model chooses tools. A skill whose `requires` are not met is listed as unavailable with the reason, and loading it returns that reason as an error.
- **Loading:** `load_skill(name)` adds the instructions to the **system message of every following request**. They are not kept in the conversation history, so compaction never elides or summarizes them. `read_skill_file(name, path)` reads a supporting file, under the same path and link rules as `read_file`, rooted at the skill's directory.
- **Cap:** all loaded skills together may use at most 15% of `CONTEXT_LIMIT`. A skill that doesn't fit is not loaded, and the model gets an error saying so.
- **Preloading:** `--skill <name>` (repeatable) loads a skill before the first step. `--no-skills`, or `SKILLS=off`, turns the system off.
- **Logging:** `run_start` lists the available and unavailable skills. Each load is logged as `skill_loaded`, and the result has `skillsLoaded`.

### Read-only skills and safety

While a `readOnly: true` skill is loaded:
- `write_file` and `edit_file` return an error;
- MCP tools that need confirmation (`click`, `fill`, `evaluate_script`, …) are disabled;
- `run_shell` accepts only this allowlist: **`git diff`, `git log`, `git show`, `git status`**.
  - Arguments may contain only letters, digits, spaces and `_ - . / : = @ ~ , +`. That rules out chaining and substitution (`&& ; | \` $( )`), redirection (`< >`), cmd.exe escapes and variables (`^ %`), quotes and newlines. `git diff && rm x` is rejected, for example.
  - `--output`, `--ext-diff` and `--textconv` are rejected, because they write files or run external programs.
  - Allowed commands still ask for confirmation as usual.
  - **Not covered:** a repository's own git configuration (e.g. a configured diff driver) is outside this check.

**Skills are trusted instructions you wrote, but they can't change the harness's safety rules.** Confirmations, path restrictions and the untrusted-content guard all still apply while a skill is loaded.

### Writing a skill

Start the description with what the skill does, then say when to use it ("Use when asked to …"). That description is all the model sees before loading.

In the body:
- **Steps:** numbered, each ending in a checkable "Done when …".
- **Output format:** state it explicitly.
- **Stop conditions:** say when the work is finished, and when to stop and report instead.
- **Prohibitions:** keep a short list, only for real guardrails.
- **Tool names:** use the harness's real tools (`list_dir`, `grep`, `read_file` with `offset`/`limit`, `edit_file`, `run_shell`, `read_tool_result` with `pattern`, `mcp__…`).
- **Length:** stay under about 1,200 tokens. Move material that only some runs need into a supporting file, as `code-review` does with its checklist.

[TEST_REPORT.md](TEST_REPORT.md) (Phase 6) measures each bundled skill with and without skills.

## Architecture

```
bin/harness.js        Global `harness` entry: registers tsx, runs src/index.ts
src/
├── index.ts          CLI entry: --cwd/--help parsing, env checks, then calls runAgent
├── config.ts         ~/.harness paths and .env loading
├── agent.ts          runAgent(): main loop, provider-agnostic (no `openai` import)
├── confirm.ts        Terminal y/N prompt
├── process.ts        Process-tree kill, registry of long-lived children, Ctrl+C shutdown
├── types.ts          Tool / ToolContext types
├── mcp/
│   ├── config.ts     mcp.json loading and validation, --mcp / --no-mcp selection
│   ├── transport.ts  stdio transport over a child process the harness controls (tree shutdown)
│   ├── manager.ts    Starts servers in parallel, wraps their tools (naming, filtering, confirmation, timeouts)
│   ├── convert.ts    Schema cleanup and result conversion (text, image notes, resources, errors)
│   ├── resultPages.ts  Paging of oversized results and the read_tool_result tool
│   └── names.ts      mcp__server__tool names
├── skills/
│   ├── load.ts       SKILL.md discovery and frontmatter validation
│   └── registry.ts   Availability, load_skill / read_skill_file, pinning, cap, read-only rules
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
- **Known files and coverage:** paths from every file listing are collected and shown in a `[Harness status]` message attached to each request, together with which files have not been read yet. It is never stored in history, so compaction can't remove it. Level 2 summaries end with this harness-computed unread list.
- **Coverage check:** if the model tries to finish a whole-project task while listed files are unread, the harness asks it once to read them or say what it skipped. Set `COVERAGE_CHECK=off` to disable.
- **Context-length errors:** if the API still returns one, the harness forces compaction and retries once. If that fails too, it stops with `stopReason: "error"`.

Everything is printed (`⟳ Compaction L1: ~6,744 → ~3,973 tokens …`) and logged to the JSONL file: `compaction`, `level2_rejected`, `level2_skipped`, `describe_failed`, `repeated_call`.

See **Configuration** above for all settings (`CONTEXT_LIMIT`, `COMPACT_THRESHOLD`, `RECENT_BUDGET`, `COMPACT_MODEL`, `COVERAGE_CHECK`, `COVERAGE_FOOTER`, `MAX_STEPS`).

**Size caps:**
- No single tool result may exceed 25% of the context limit. `read_file` results are cut at a line boundary with `[Truncated at line N of M. Use read_file with offset=N+1 …]`.
- The results of one turn together may not exceed 50%; the largest are shrunk first.
- Before every request, if the estimate still exceeds the limit, the newest results are shrunk (`preflight_truncated`).

**Token estimates:** Chinese, Japanese and Korean characters count as about 1 token each, and other text as about 3.5 characters per token. The estimates are calibrated against the API's real token counts during each run.

**Answers:**
- If the reply after a coverage check is much shorter than the previous answer, both are kept.
- Unread files are listed in a footer written by the harness (`COVERAGE_FOOTER`).

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
- `--compact-model <model>`: use a different model for compaction calls (default: the model under test).
- `--without-mcp`: skip the tasks that need an MCP server.
- `--without-skill-tasks`: skip the with/without-skills tasks (`onboarding`, `bugfix`, `web-research`, `code-review`).
- `--skills off|available|preloaded`: `off` (default) runs without skills. `available` lists the bundled skills, so the model has to decide to load one. `preloaded` loads the task's skill up front. Skills always come from the repository's `skills/`, never from `~/.harness/skills/`.

All harness settings are passed to each run explicitly, so your environment and `~/.harness/.env` don't affect eval results. The same goes for MCP: a task gets only the servers it declares, so `~/.harness/mcp.json` is never read.

**Web tasks** (`read-page`, `multi-page`, `long-page`, `prompt-injection`):
- **Requirements:** Chrome and network access for `npx` (the runner pre-downloads the pinned `chrome-devtools-mcp` once).
- **Pages:** each run serves its fixture pages from a local HTTP server on `127.0.0.1`; evals never use the public internet.
- **Browser:** each run starts its own headless browser with an isolated profile.
- **Process cleanup:** `npx tsx evals/cleanup-check.ts` checks, without API calls, that no server or Chrome processes are left behind after normal end, error, timeout, SIGINT and a hard kill. With large tasks, keep `--concurrency` low: parallel jobs can hit your organization's tokens-per-minute limit (HTTP 429).

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
