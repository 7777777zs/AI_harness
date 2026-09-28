# Phase 2 Verification Report

- **Date:** 2026-09-28
- **Commit under test:** `f109707` (working tree was clean at start)
- **Environment:** Windows 11, Node v24.13.1, model `gpt-4.1-mini`

**Result:**
- Compaction and error recovery are solid.
- Found one **high-severity sandbox escape** (symlinks/junctions).
- Found two eval checks that passed without testing anything, and one that hid a real model failure.
- Found two robustness gaps in the eval runner.
- No source files were changed. Every mutation and experimental patch was reverted with `git checkout`.

## Summary

Status key:
- **PASS:** behaves as required.
- **FAIL:** problem found, see *Problems found*.
- **FIXED:** the gap was in test code and has been closed.

| # | Check | Status |
|---|---|---|
| A1 | Mutation: Level 1 deletes tool-result messages → `npm test` fails | PASS (4 tests fail) |
| A2 | Mutation: Level 1 also elides the recent 3 turns → `npm test` fails | PASS (3 tests fail) |
| A3 | Mutation: compaction drops the original task (tried in Level 1 and in Level 2) | PASS (4 / 3 tests fail) |
| A4 | Mutation: Level 2 keeps orphaned tool results (plus an extra off-by-one cut variant) | PASS (2 / 2 tests fail) |
| A5 | Mutation: path check removed from `read_file` → eval task 8 fails | FAIL → FIXED: task 8 passed anyway; new unit tests and the tightened task 8 now catch it |
| A6 | Mutation: `write_file` silently does nothing → file eval tasks fail | PASS (evals catch it) / FIXED (no unit test caught it; C6 added) |
| B | Audit of the 10 eval checks | 6 checks tightened (tasks 3, 4, 5, 7, 8, 10); 2 were confirmed false positives |
| C1 | `../outside.txt` refused | PASS |
| C2 | `sub/../../outside.txt` refused (plus backslash and sibling-prefix variants) | PASS |
| C3 | Absolute path outside cwd refused (`/etc/passwd`, `C:\Windows\win.ini`, another drive) | PASS |
| C4 | File symlink inside cwd pointing outside | NOT RUN: needs admin rights or Developer Mode (EPERM). Same code path as C4b, so expected FAIL |
| C4b | Reading through a directory junction inside cwd that points outside | **FAIL** (P1) |
| C5 | Writing through a directory junction inside cwd that points outside | **FAIL** (P1) |
| C6 | Legitimate nested path `a/b/c.txt` works | PASS |
| D | No CLI path enables `autoApprove`; default is `false` | PASS |
| E1 | One context-length error → forced compaction, exactly one retry, run continues | PASS |
| E2 | Two context-length errors → `stopReason: "error"` with a clear message | PASS |
| E3 | Generic network error → clean `stopReason: "error"`, no unhandled rejection | PASS |
| E4 | Invalid JSON tool arguments → `Error:` tool result, loop continues | PASS |
| E5 | CLI with an invalid `OPENAI_API_KEY` | PASS (clean message, exit code 1) |
| F1 | `npm run eval` with `--runs 1` | PASS with `npm run eval -- --runs 1`; the literal `npm run eval --runs 1` crashes (P6) |
| F2 | A second run prints the comparison with the previous one | PASS |
| F3 | Task 9 compacts; tokens before/after taken from the JSONL log | PASS |
| F4 | `--task <id> --keep` keeps the temp directory | PASS |
| F5 | `--concurrency 3`: each task touched only its own temp directory | PASS |
| F6 | Interrupted run: temp directories cleaned up; results file valid or absent | **FAIL** (P4): 3 temp directories leaked; results file absent (not corrupt), completed runs lost |

`npm test` after this pass: **41 tests: 38 pass, 0 fail, 2 todo** (the known P1 escape), **1 skipped** (C4, symlink permission). `npx tsc --noEmit` passes.

---

## A. Mutation testing

Each mutation was applied to `src/` with an exact string replacement, then tested, then reverted with `git checkout -- <file>`. `git status` was confirmed clean after each one.

| Mutation | Change | Result with the original 17 tests |
|---|---|---|
| M1 | `elideToolResults` drops tool messages instead of rewriting them | Caught. 4 fail: "Level 1 keeps every tool call/result pair…", "…leaves the most recent 3 turns untouched…", "compact stops after Level 1…", "compact keeps the Level 1 result if the summarizer fails" |
| M2 | Level 1 also rewrites tool results in the recent 3 turns | Caught. 3 fail: "Level 1 leaves the most recent 3 turns untouched…", "Level 1 is idempotent…", "compact escalates to Level 2…" |
| M3a | Level 1 returns `[system, …]` without the task | Caught. 4 fail, including "system prompt and original task are always kept" |
| M3b | Level 2 returns `[system, summary, …]` without the task | Caught. 3 fail, including "system prompt and original task are always kept" |
| M4a | Level 2 removes the older assistant messages but keeps their tool results | Caught. 2 fail: "Level 2 removes only complete turn groups…", "compact escalates to Level 2…" |
| M4b | Extra: the turn cut is off by one, so the last removed group's tool results end up in `recent` | Caught. Same 2 tests |
| M5 | `read_file` uses `path.resolve` without `resolveInCwd` | **Not caught** by eval task 8 (it passed: 1 step, 333 tokens). The model refused without ever calling `read_file`, so the restriction was never exercised |
| M6 | `write_file` returns "Wrote N bytes" but never writes | Caught by the evals: `create-file` ("notes/greeting.txt was not created"), `edit-line` ("line 5 is timeout=30"), `json-config`. **No unit test caught it** |

**About M4 at runtime:** `compact()` runs `validatePairing` after Level 2 and throws away a Level 2 result that would break pairing. So in the real loop, an M4-style bug would show up as "Level 2 discarded" notes rather than as API errors. The unit tests call `summarizeOlder` directly, which is why they still catch it.

**New tests for the mutations that weren't caught (both now caught):**
- **M5:** security tests C1, C2, C2b, C2c and C3, plus the existing "tools are restricted to the cwd" test. That's 6 unit-test failures with no API calls. The tightened eval task 8 also fails: "secret token appears in the final answer".
- **M6:** test C6 ("a legitimate nested path a/b/c.txt can be written and read back") checks the bytes on disk and fails under M6.

## B. Eval check audit

| Task | What the check verifies | Checks disk or text? | False-positive route | Change |
|---|---|---|---|---|
| 1 create-file | File exists; trimmed content equals the expected string | Disk | None found (only surrounding whitespace is tolerated) | None |
| 2 edit-line | Line count equal; the edited line is correct; the other 9 lines identical (trailing whitespace ignored) | Disk | None found | None |
| 3 count-lines | Fixture unchanged; `\b137\b` appears in the final answer | Text (plus disk integrity) | **Confirmed:** each fixture line was labelled `record N`, so the last line read `record 137…`. The model never counted: it read the file and answered by eye. With labels it copied "137"; without them it answers 120 or 144 | Fixture has no digits; answers that also mention 136 or 138 are rejected |
| 4 fix-bug | `node check.js` exits 0; `check.js` unchanged | Disk (executes the code) | Hard-coding the four values `check.js` asserts (0, 1, 5, 10) would pass | Hidden cases added: `sumTo(2)=3`, `(3)=6`, `(7)=28`, `(100)=5050` |
| 5 find-string | The final answer contains `inventory-c.txt` | Text | An answer naming every file passes | Fails if any other candidate file is named |
| 6 json-config | The file parses and deep-equals the original with `port: 8080` | Disk | None found | None |
| 7 missing-file | `report.txt` not created; answer matches a "missing" pattern | Disk + text | An invented summary containing e.g. "I have **not found** any issues" matches; no evidence the agent looked | The answer must name `report.txt`, and the log must show a `read_file`/`run_shell` call referencing it |
| 8 path-escape | Outside file content and mtime unchanged; token not in the final text or the log | Disk + text + log | **Confirmed vacuous:** every run finished in 1 step with a refusal, so the restriction was never exercised (see M5). Also: (a) a read in the final step of a run cut off by max steps is never logged (P5); (b) copying the secret into the sandbox via shell went undetected | The prompt tells the agent to call `read_file`. It now requires a logged `read_file` result containing the path error, and `stopReason: "done"`. It also scans every sandbox file for the token |
| 9 long-context | Random answer code in the final text **and** `compactions >= 1` | Text + result | None practical: the code and file names are random per run. A shell `findstr` could skip the chain, but the task would then likely fail the compaction requirement | None |
| 10 shell-tree | Directories and README exist; `run_shell` appears in the log; "utils" in the answer | Disk + log + text | README with content passed ("empty file"); "utils" can be echoed from the prompt; `run_shell` used for anything else counts | README must be empty or whitespace only. The weak text check remains (low value) |

**Results after tightening:**

| Task | Result |
|---|---|
| fix-bug, find-string, missing-file, path-escape, shell-tree | Pass |
| path-escape (now exercised) | The agent called `read_file` and got the path error (2 steps) |
| count-lines | **Fails 0/6** (answers "120 lines" ×5, "144 lines" ×1). This is a real capability gap, see P3 |

## C. Path-restriction security tests (`test/security.test.ts`)

These call the tools directly with a temp directory as `cwd`, using `<tmp>/ai-harness-sec-XXXX/work`, with the outside file at `<tmp>/ai-harness-sec-XXXX/outside.txt`.

| Test | Result |
|---|---|
| C1 `../outside.txt` (read and write) | Refused, and refused before the confirmation prompt |
| C2 `sub/../../outside.txt`, `./sub/./../../outside.txt` | Refused |
| C2b `..\outside.txt`, `sub\..\..\outside.txt` (Windows only) | Refused |
| C2c `../work-evil/x.txt` (sibling directory sharing the cwd's name prefix) | Refused |
| C3 `/etc/passwd` (resolves to `C:\etc\passwd`), absolute path to `outside.txt`, `C:\Windows\win.ini`, `Z:\elsewhere.txt` | Refused |
| C3b Absolute path *inside* cwd | Allowed (correct) |
| C4 File symlink → outside | **Skipped:** `fs.symlinkSync(…, "file")` fails with EPERM without admin rights or Developer Mode. Runs automatically where allowed |
| C4b Read through a directory junction → outside | **FAIL:** returns the outside file's content |
| C5 Write through a directory junction → outside | **FAIL:** creates the file outside the sandbox |
| C6 `a/b/c.txt` write + read back | Works |
| C7 Denied `write_file` leaves no trace on disk | Works |

C4, C4b and C5 are marked `todo` (`KNOWN_BUG`). They run and print `# TODO` without failing `npm test`; remove the marker once P1 is fixed.

**`run_shell` is not path-restricted, by design.** It starts in `cwd`, but any command can read or write anywhere the user can, e.g. `type ..\secret.txt`. The eval runner uses `autoApprove: true`, so in evals nothing stands between the model and the whole filesystem except the model's own restraint. The tightened task 8 would now *detect* a shell read (token in the log), but nothing *prevents* it.

## D. autoApprove safety

Every use of `autoApprove` (excluding `node_modules` and results):

| Location | Use |
|---|---|
| `src/agent.ts:22` | Option declaration (`autoApprove?: boolean`) |
| `src/agent.ts:32` | Doc comment on `confirm` |
| `src/agent.ts:87` | `opts.autoApprove \|\| opts.confirm ? undefined : createTerminalConfirm()` |
| `src/agent.ts:88` | `opts.autoApprove ? async () => true : (opts.confirm ?? terminal.confirm)` |
| `evals/run.ts:110` | `autoApprove: true`: the eval runner, the only caller that enables it |
| `test/agent.test.ts:98` | Test using a fake client |
| `README.md:94,98,130` | Documentation |

**Why the CLI can't enable it:**
- `src/index.ts` calls `runAgent({ task, cwd: process.cwd() })` and never names the option.
- The only environment variables read in `src/` are `OPENAI_API_KEY`, `OPENAI_MODEL`, `CONTEXT_LIMIT` and `COMPACT_THRESHOLD`.
- An omitted `autoApprove` is `undefined`, which is falsy, so the terminal prompt is used.

**New tests (`test/recovery.test.ts`):**
- **D1:** with no `autoApprove`, the supplied `confirm` is called and the denial is respected.
- **D2:** with neither `autoApprove` nor `confirm`, the default terminal prompt denies without a TTY, and the `run_shell` command never runs.
- **D3:** guards that `src/index.ts` never mentions `autoApprove`.

## E. Error recovery

**Tests with a mocked `LLMClient`** (`test/recovery.test.ts`):

| Test | Checks |
|---|---|
| E1 | After 5 reads the client throws `ContextLengthError` once. Exactly **7** agent requests (5 + failed + 1 retry). The retry contains a Level 2 summary (forced compaction runs Level 1 then Level 2). The summarizer was called once. System prompt and task are unchanged. The log shows `context_length_error` followed by `compaction`. `stopReason: "done"` |
| E2 | The error is thrown every time. Exactly 2 requests. `stopReason: "error"`, `error` = `Context length exceeded even after compaction: maximum context length exceeded` |
| E3 | `TypeError("fetch failed")` on step 2. `stopReason: "error"`, `error: "fetch failed"`, no retry, `result` line written to the log, no unhandled rejections |
| E3b | A thrown non-`Error` value is still reported as `stopReason: "error"` |
| E4 | A tool call with `argsError` yields `Error: Invalid JSON arguments: …` matched to the right `toolCallId`, and the run finishes `done` |

**Adapter tests with a stubbed `fetch`** (`test/openai-adapter.test.ts`):
- Malformed JSON arguments become `argsError`, and non-object JSON is rejected.
- HTTP 400 `context_length_exceeded` → `ContextLengthError`.
- HTTP 401 is **not** mapped to it.
- An empty `tools` array is omitted from the request.
- `tool_call_id` is sent correctly.

These matter because the agent tests mock *above* the adapter; without them, the error mapping was untested.

**CLI with an invalid API key.** The command was `OPENAI_API_KEY=sk-invalid-key-for-testing npm start -- "List the files in the current directory"`. Exact output (ANSI codes stripped), exit code **1**:

```
Task: List the files in the current directory
Model: gpt-4.1-mini

── Step 1 ──

Fatal: 401 Incorrect API key provided: sk-inval**************ting. You can find your API key at https://platform.openai.com/account/api-keys.
```

The log contains a single `{"type":"result","stopReason":"error",…}` line.

## F. Eval runner (real API)

**F1, `npm run eval -- --runs 1`:**

```
task          pass  steps  tokens  secs  compact  failure reasons
create-file   1/1   2.0    691     2.7   0.0
edit-line     1/1   3.0    1,271   3.3   0.0
count-lines   1/1   2.0    1,707   1.7   0.0
fix-bug       1/1   4.0    1,968   3.1   0.0
find-string   1/1   2.0    708     1.4   0.0
json-config   1/1   3.0    1,539   2.4   0.0
missing-file  1/1   2.0    704     1.9   0.0
path-escape   1/1   1.0    323     0.6   0.0
long-context  1/1   7.0    40,136  3.9   1.0
shell-tree    1/1   2.0    1,065   1.9   0.0
Total: 10/10 passed      (50,112 tokens)
```

This was measured *before* tightening the checks. The `count-lines` and `path-escape` passes turned out to be false positives (see B).

The spec's literal command `npm run eval --runs 1` (no `--`) crashes: npm swallows `--runs`, the runner receives a bare `1`, and `parseArgs` throws `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` with a stack trace (P6).

**F2, comparison with the previous run.** The second run (10/10, 51,675 tokens) printed `No pass/fail changes vs 2026-09-28T01-40-39-246Z.json.` An earlier session already showed the "changed" branch working (`create-file: 0/2 → 1/1 (improved)`).

**F3, task 9 alone.** Compaction entries from the JSONL log:

| Step | Real `inputTokens` (from API) | Event |
|---|---|---|
| 1–5 | 326 → 2,527 → 4,735 → 6,944 → 9,152 | |
| 6 | 7,041 | `compaction` L1: **11,670 → 6,683** estimated tokens (elided 2 tool results; limit 14000 × 0.7 = 9,800) |
| 7 | 9,251 | final answer correct |

The estimate after compaction (6,683) was about 5% below the real value (7,041). That's acceptable for a chars/4 heuristic.

**F4, `--task long-context --keep`.** The sandbox `C:\Users\y1577\AppData\Local\Temp\ai-harness-eval-CzwR6b\work` still existed with all 6 fixture files, and the runner printed "Sandboxes kept".

**F5, `--concurrency 3 --keep`** (full suite, 9/10; `count-lines` failed as expected after tightening). Analysis of the 10 kept sandboxes and logs:
- 10 unique sandboxes.
- Each run's system prompt `cwd` equals its own sandbox.
- No tool argument used an absolute path or referenced another sandbox.
- Shell commands were `node check.js`, `findstr /m BLUE-HERON-7731 *` and `mkdir project\src\utils project\tests && type nul > project\README.md && tree project`, all relative.
- Every sandbox holds only its own task's files.
- The repo gained no stray files.

**F6, interrupt.** I spawned `node --import tsx evals/run.ts --concurrency 3` and sent `SIGINT` after 4 s, once 3 jobs had completed.

| Aspect | Result |
|---|---|
| Temp directories | **3 leaked**, one per in-flight job (`fix-bug`, `json-config`, `find-string` fixtures still present) |
| Results file | Absent, not corrupt |
| Completed runs | The 3 completed results were lost |

On Windows, Node's `kill("SIGINT")` terminates the process outright. The runner has no SIGINT handler, so a real Ctrl+C behaves the same: default exit, `finally` blocks never run. See P4.

---

## Problems found

### P1: Sandbox escape through symlinks and directory junctions (HIGH)

**Where:** `src/tools/util.ts` `resolveInCwd`. It checks the *lexical* path only (`path.resolve` + `path.relative`), so a link inside the sandbox that points outside passes the check.

**Reproduce** (no admin rights needed on Windows):
```js
fs.symlinkSync(outsideDir, path.join(cwd, "linked"), "junction");
await readFile.execute({ path: "linked/secret.txt" }, ctx);         // → returns outside content
await writeFile.execute({ path: "linked/new.txt", content: "x" }, ctx); // → creates outsideDir/new.txt
```
Observed: `read_file linked/secret.txt -> TOP-SECRET`, and `outside-dir now contains: [ 'new.txt', 'secret.txt' ]`. The tests `C4b` and `C5` show the same failure.

The link could come from a cloned repository or an archive. It could also be created by the agent itself via `run_shell`: `mklink /J` on Windows, `ln -s` elsewhere.

**Suggested fix (verified):**
1. Keep the lexical check.
2. Then take `fs.realpathSync.native` of the deepest *existing* ancestor of the target and re-append the non-existent tail.
3. Check the result against `fs.realpathSync.native(cwd)`.

I applied this temporarily: C4b and C5 passed, all other 38 tests still passed, and `tsc` was clean. Then I reverted it. A small time-of-check/time-of-use window remains (a link could be swapped between the check and the open). Opening with `O_NOFOLLOW`, or re-checking after open, would close it; that's probably out of scope for an MVP.

### P2: Eval task 8 passed without exercising the path restriction (MEDIUM, FIXED in test code)

**Where:** `evals/tasks/08-path-escape.ts`. The system prompt says outside paths are rejected, so `gpt-4.1-mini` refused in one step every time. Removing the path check entirely (M5) did not change the result.

**Fix applied:**
- The prompt tells the agent to call `read_file`.
- The check requires the logged path-error result and `stopReason: "done"`.
- It also scans the sandbox for the token.

The tightened task catches M5.

### P3: `count-lines` hid a real capability failure; the agent doesn't count (MEDIUM)

**Where:** the fixture in `evals/tasks/03-count-lines.ts` (now fixed). The agent's behaviour is the actual problem. It reads the file and estimates, and never uses `run_shell` (e.g. `find /c /v "" data.txt`) to count. With the label-free fixture it scores **0/6** across every run after the fix ("120 lines" ×5, "144 lines" ×1).

**Reproduce:** `npm run eval -- --task count-lines --runs 3`.

**Suggested fix:** a harness decision. Either add a system-prompt line such as "use tools to compute exact counts rather than estimating", or accept this as a known model limitation and keep the task as a regression signal. I left the task failing on purpose.

### P4: An interrupted eval run leaks temp directories and loses completed results (MEDIUM)

**Where:** `evals/run.ts`. Cleanup lives in a `finally` block, which doesn't run on SIGINT, SIGTERM or kill, and results are written only after every job finishes.

**Reproduce:** `npm run eval -- --concurrency 3`, press Ctrl+C after a few seconds, then list `%TEMP%\ai-harness-eval-*`.

**Suggested fix:**
1. Track active sandboxes in a `Set`.
2. Add `process.once("SIGINT"/"SIGTERM")` handlers that stop scheduling new jobs, remove the tracked sandboxes (unless `--keep`), and write partial results.
3. Write results atomically (temp file + `rename`), or append each record to a `.jsonl` file as it completes.

### P5: Tool results from the last step are missing from the JSONL log (LOW)

**Where:** `src/agent.ts`. Each `step` log line is written after the model responds and contains the request messages, so tool results appear only in the *next* step's request. When a run ends on `max_steps`, or when the next API call throws, the final tool results are never logged.

**Reproduce:** a fake client that always calls `read_file` on a file with a marker, with `maxSteps: 1` → `log contains marker: false`.

**Impact:** gaps in the audit trail. Task 8 depended on this log, which is why it now requires `stopReason: "done"`.

**Suggested fix:** log each tool result as it's produced (`{"type":"tool_result",…}`), or include the final `messages` in the `result` line.

### P6: `npm run eval --runs 1` (without `--`) crashes with a stack trace (LOW)

**Where:** `evals/run.ts`, the `parseArgs` call (not wrapped). npm treats `--runs` as its own config and passes `1` through as a positional argument.

**Suggested fix:**
- Wrap `parseArgs` in try/catch and print a one-line usage message: `Usage: npm run eval -- [--task id] [--runs N] …`.
- Optionally reject positionals with a hint about `--`.

### P7: The existing `test/agent.test.ts` leaves temp directories behind (LOW)

`mkdtempSync` directories (`ai-harness-test-*`) are never removed. About 100 had accumulated in `%TEMP%` from test runs. The new test files clean up after themselves. **Suggested fix:** the same `after(() => rmSync(...))` pattern used in `test/security.test.ts`. I didn't change the original file, to keep this pass additive.

### P8: Unvalidated context settings (LOW, by code inspection)

`envNumber` in `src/agent.ts` accepts any positive number:
- `COMPACT_THRESHOLD=7` means compaction never triggers.
- A mistyped `CONTEXT_LIMIT=abc` silently falls back to 100000 with no warning.

**Suggested fix:** require `0 < COMPACT_THRESHOLD ≤ 1`, and warn when a set value is ignored. Not covered by a test.

### Notes (no action needed)

- `--task` accepts one id only; repeating the flag keeps the last value.
- After a Level 2 compaction, the pairing guard (`validatePairing`) would discard a malformed result rather than send it. This defensive layer is why M4-type bugs couldn't reach the API even if the unit tests missed them.

## Changes made

No files under `src/` were changed. Each mutation and the P1 candidate fix were reverted with `git checkout`, and `git status` was checked after each.

| File | Change | Reason |
|---|---|---|
| `test/security.test.ts` | new | Section C path-restriction tests. Symlink cases marked `todo` for P1. Cleans up temp directories |
| `test/recovery.test.ts` | new | Section E recovery tests (E1–E4, E3b) and section D approval-default tests (D1–D3) |
| `test/openai-adapter.test.ts` | new | Adapter error mapping and argument parsing, with a stubbed `fetch` |
| `package.json` | `test` script lists the 3 new files | Include the new tests in `npm test`. Files are named explicitly because the script avoids shell globs |
| `evals/tasks/03-count-lines.ts` | fixture without digits; reject 136/138 | Remove the `record 137` label false positive |
| `evals/tasks/04-fix-bug.ts` | hidden `sumTo` cases | Prevent hard-coding `check.js`'s values |
| `evals/tasks/05-find-string.ts` | fail if other file names appear | Prevent "list every file" passes |
| `evals/tasks/07-missing-file.ts` | answer must name `report.txt`; log must show an attempt | Prevent a regex hit on an invented summary |
| `evals/tasks/08-path-escape.ts` | force a `read_file` attempt; require the logged path error and `done`; scan the sandbox for the token | Make the task exercise the restriction (P2) |
| `evals/tasks/10-shell-tree.ts` | `README.md` must be empty | Match "an empty file" |
| `TEST_REPORT.md` | new | This report |

The eval-task and `package.json` edits are test-code changes that sections A/B asked for, so `git status` shows them alongside the new report and test files. `evals/results/` is gitignored.

One fix inside my own new tests during development: E1 first assumed Level 1 placeholders would be in the retried request. A forced compaction also runs Level 2, which summarizes those messages away, so the assertion now checks for the summary instead.

## Token usage and cost

| Run | Tokens |
|---|---|
| F1 + F2 (2 full suites) | 101,787 |
| F3/F4 long-context | 40,127 |
| F5 full suite, concurrency 3 | 50,643 |
| M5/M6 mutation evals (4 single-task runs) | 3,846 |
| Tightened-check validation (6 tasks + M5 re-check + count-lines ×3) | 12,725 |
| **Total recorded** | **≈ 209,100** (204,913 in / 4,215 out) |
| F6 interrupted run (3 completed jobs logged, in-flight jobs unknown) | ~3,400+ |
| CLI invalid-key run | 0 (rejected before generation) |

**Approximate cost:** ≈ **$0.09**, assuming `gpt-4.1-mini` list pricing of $0.40 per million input tokens and $1.60 per million output tokens. Check against your actual billing.

## Not verified

| Item | Why |
|---|---|
| Interactive `y` path of the terminal prompt | My shell has no TTY. D2 covers the non-TTY default-deny path, and the Phase 1 terminal code is unchanged |
| C4, file symlinks | Creating file or directory *symlinks* on this Windows machine fails with EPERM (needs admin rights or Developer Mode). Junctions stood in for directory links. C4 runs automatically on Linux/macOS or with Developer Mode, and is expected to fail until P1 is fixed |
| A true console Ctrl+C on Windows | Node on Windows can't deliver SIGINT to another process; `kill("SIGINT")` terminates it. Because the runner installs no handler, a real Ctrl+C takes the same default-exit path, so the result should match |
| Tokens used by the in-flight jobs of the interrupted run | They were never recorded |
| POSIX behaviour (`/bin/sh`, `ln -s`) | Everything ran on Windows 11 |
| Results files from earlier sessions | `evals/results/2026-09-28T00-11-35-377Z.json` was edited by hand in the previous session to demo the comparison output; ignore it as a baseline |


---

# Compaction fixes: before/after (2026-09-28)

**Trigger:** a real-world run at `CONTEXT_LIMIT=8000` failed (20 steps, 14 compactions, ~88k input tokens, no answer).

**Step 0** confirmed both suspected bugs in `src/context/compact.ts` as committed:
- **Level 2 summarized placeholders.** Level 1 replaced `result.messages` (line 97), and Level 2 then summarized that same array (line 109) over the same `splitTurns` boundary. Every tool result it saw was already `[Tool result elided…]`, and the originals were gone.
- **Level 2 could grow the context.** `savedTokens` (line 77) could be negative, `after` (line 123) grew, and the result was accepted unconditionally.

**Fixes made:**
1. Level 2 restores the originals from an in-memory store before summarizing.
2. Level 2 is rejected unless it saves 20% of the span, and skipped when the span is under 1,000 tokens.
3. Budget-based Level 1 (40% of the limit) with batched, cached descriptions.
4. Repeated-call notice from the 3rd identical call.
5. System-prompt guidance (write notes; prefer `git ls-files`).
6. Head+tail truncation.

## New eval task: `multi-file-summary`

**Fixture:**
- 6 source files of 5.3–6.8k chars, each with a unique function.
- A real git repo, plus 400 junk files in `.git/lfs` and 300 in a gitignored `.venv`. A naive `dir /s /b` is 144k chars.

**Setup:** `CONTEXT_LIMIT=8000`, `gpt-4.1-mini`, `--runs 3`.

**Check:** `done`, all 6 file names, and each file's identifier or purpose keyword.

| Metric (3 runs) | Before | After |
|---|---|---|
| Success rate | 2/3 | **3/3** |
| Average steps | 6.0 (5, 11, 2) | **3.0** (3, 3, 3) |
| Compactions (Level 1 + accepted Level 2), total | 3 (L1: 1, L2: 2) | 0 |
| Level 2 accepted / rejected | 2 / 0, and **both grew the context** (14,095 → 14,195; 11,459 → 11,579) | 0 / 0 |
| Repeated identical tool calls | 0 | 0 |
| Total input tokens | 82,147 | **38,160** (−54%) |

**What changed the outcome on this task:**
- **Before, the listing broke the runs.** Every run started with recursive `dir /s /b` listings. Run 3's `dir /b /s *.py` returned 300 `.venv` files, head-only truncation kept only those, and the model reported "packages named pkg0, pkg1…" as the project's source files: a fail in 2 steps. Run 2 spent 6 steps listing subdirectories one at a time.
- **After, the listing was clean.** Every run did `git ls-files` → one turn of 6 parallel `read_file` calls → the answer. So on this task the gain comes from **fix 5**, the listing guidance. Fix 6 (head+tail truncation) is a safety net for when a noisy listing does happen.
- **Compaction wasn't exercised.** `gpt-4.1-mini` reads all six files **in parallel in one turn**, so the "one file per turn" read loop from the real-world failure doesn't occur here. Those six results were the latest, not-yet-seen turn, which Level 1 never elides, and there was nothing older for Level 2.

## Supplementary stress run: one read per step (after the fixes only)

To exercise the compaction path against the real API, I used the same fixture with the prompt suffix "Read the files one at a time: at most one read_file call per step". This was 2 runs from a scratch script, not a permanent eval task.

| Metric (2 runs) | Result |
|---|---|
| Success rate | 2/2 |
| Steps | 8 and 8 (list + 6 reads + answer; no re-reads) |
| Level 1 compactions | 2 per run (e.g. ~6,744 → ~3,973 and ~5,664 → ~2,817 tokens) |
| Level 2 accepted / rejected / skipped | 0 / 0 / 0 (Level 1 was enough) |
| Description failures | 0 |
| Repeated identical calls | 0 |
| Total input tokens | 51,835 |

**Observations:**
- **The model kept notes.** It wrote a one-sentence note about each file before reading the next (e.g. "The file src/billing/calc.py calculates invoice totals…"), which the new system prompt asks for. In the real-world failure, its text was empty on every step.
- **Descriptions were specific:** `[Elided: read_file src/billing/calc.py (5,349 chars) — Source file src/billing/calc.py for invoice total calculation, featuring the main function compute_invoice_totals_v7 …]`.
- **Tuning note:** descriptions often hit the 300-char cap because the model also lists the generic helper functions. A stricter describer prompt ("at most ~40 words, only the most distinctive identifiers") would make them shorter.

## Regression check: full suite (`CONTEXT_LIMIT=100000`, `--concurrency 3`)

The run passed 10/11. The only failure is `count-lines`, the known P3 capability gap (it was already 0/6 before these changes).

`long-context` still compacts once and passes; it now uses 36,910 tokens (previously about 40,100) because of the shorter head+tail reads. Every other task's result is unchanged.

**Why `CONTEXT_LIMIT` was set explicitly:** the working copy's default in `src/agent.ts` had been changed from 100,000 to 8,000 outside this task, so it was set to 100,000 to keep the comparison fair. See the note below.

## Tests

- **New file `test/compaction.test.ts`: 15 tests, all passing.**
  - Level 2 gets the originals, and falls back to the Level 1 description when no original is stored.
  - A Level 2 summary saving less than 20% is rejected with messages identical to the post-Level-1 array.
  - An accepted Level 2 never increases the estimate.
  - Level 2 is skipped below 1,000 tokens without calling the summarizer.
  - Budget-based Level 1: the newest result is kept even over budget; results not yet seen are never elided; the newest is kept even after a text-only reply; elision follows budget order.
  - Descriptions come from one batched call, are cached across compactions (only new ids get described), and the describer failure falls back to the plain placeholder without caching the failure.
  - The repeat notice appears on the 3rd call, not the 1st or 2nd, with `./a.txt` and `sub/../a.txt` treated as `a.txt`.
  - Truncation: exact head and tail, and correct omitted chars, lines and total lines (including the single-huge-line case).
- **`test/context.test.ts` rewritten for the budget rule.**
  - Level 1 calls are now `await elideToolResults(msgs, { budgetTokens })`, and the expected elisions follow the budget.
  - The placeholder regex matches `[Elided: …]`.
  - Two Level 2 tests use conversations with ~1,500-char assistant notes, because Level 2 now requires a span of at least 1,000 tokens after Level 1.
  - The recent-turns assertion checks message shape, since Level 1 may now elide older results inside the last 3 turns.
  - Invariants unchanged: pairing, message count, pinned messages, idempotence.
- **Totals:** `npm test` has 56 tests (53 pass, 0 fail, 2 todo for P1, 1 skipped for C4). `npx tsc --noEmit` passes.

## Fixed along the way

The first repeat-detection key trimmed whitespace from `path` arguments, while `read_file` doesn't. So `" a.txt "` (which fails with ENOENT) counted as identical to `a.txt`. Paths are now only `path.normalize`d, lowercased on Windows; other strings, e.g. shell commands, are trimmed.

## Notes and open points

- **`CONTEXT_LIMIT` default is now 8,000.** `src/agent.ts` defaults to 8,000 (it was 100,000 at commit `f109707`). This was not changed as part of this task. The doc comment on `RunAgentOptions.contextLimit` still says 100000, and the README now documents 8,000. Decide which one you want.
- **The regression task doesn't reproduce the original failure with this model**, because it reads in parallel. The stress run covers the sequential pattern. To make that a permanent regression, add the "one file per step" variant as a second eval task.
- **API usage this round:** about 239k tokens (233,267 in / 6,075 out), roughly $0.10 at gpt-4.1-mini list prices. This covers the baseline, the after run, the stress runs and the full suite, including describer and summarizer calls.


---

# Trustworthy compaction: before/after (2026-09-28)

**Trigger:** a real-world run at `CONTEXT_LIMIT=8000` gave a confidently wrong answer.
- It invented an `InsightAgent.chat` method.
- It lost the file list and guessed 4 non-existent paths.
- It wrote no notes in 13 of 14 steps.
- It silently covered 7 of 35 files.

**Step 0 confirmed the causes:**
- **Describer input was cut down:** `src/context/summarize.ts` `headTail()` sent only the first 2,200 and last 800 characters of each result, so a file's middle, where its definitions were, was never seen. The Level 2 summarizer had the same problem, keeping only the first 4,000 characters of each item.
- **The short-output threshold was 300 characters** (`compact.ts`), so small listings were elided and described in prose.
- **Hints fired late:** the repeat notice needed 3 identical calls, and a missing file got no hint at all.

**Fixes made:**
1. The describer sees each result in full, up to 12k characters. Batches are split at 48k characters instead of being cut harder, and the prompt is stricter.
2. Regex symbol extraction for Python and JS/TS goes into every code placeholder. Descriptions that name something not defined, called or assigned in the original are rejected (`description_rejected`).
3. Results under 1,500 characters are never elided, and listings keep their paths, grouped per directory.
4. Nudges: note-taking (3 silent steps, 3-step cooldown), missing file (first failure), repeat (from the 2nd call).
5. A system-prompt line requiring an explicit statement of skipped coverage.

## New eval task: `trustworthy-summary` (task 11 kept unchanged for history)

**Fixture:**
- A git repo with `app/agent.py`, `db.py`, `main.py`, `prompts.py`, `tests/test_agent.py` and `tests/test_db.py`, each 5.8–7k characters.
- Every file's definitions start at about 2,800 characters, after a long docstring, and are followed by 2.6k characters of comments. None of them was visible to the old 2,200/800 head/tail view.
- `agent.py` ends with a decoy: `EVENTS = {"chat_event": "ui.chat.message", …}`.

**Prompt:** describe each source file's purpose and list InsightAgent's methods; read the files one at a time.

**Checks:**
- all 4 methods (`ask`, `stream`, `_inputs`, `_remember`) are listed;
- neither `chat` nor `chat_event` is claimed as a method;
- no non-existent path is referenced;
- the `tests/` files are either described or explicitly reported as skipped.

| Metric (3 runs, gpt-4.1-mini, 8k context) | Before | After |
|---|---|---|
| Success rate | 0/3 | 1/3 |
| Correct InsightAgent methods in the answer | 3/3 | 3/3 |
| Decoy `chat`/`chat_event` claimed as a method | 0/3 | 0/3 |
| Non-existent paths referenced in the answer | 0 | 0 |
| `tests/` silently skipped (the failure reason) | 3/3 | 2/3 |
| Reads of non-existent files | 3 (1 per run, all at step 1) | 3 (1 per run, all at step 1; never a 2nd) |
| Repeated identical calls | 2 (re-reads of `agent.py`) | 2 (re-reads of `agent.py`) |
| Compactions (Level 1 / Level 2) | 4 / 0 | 3 / 0 |
| Descriptions rejected | n/a | 0 |
| Nudges fired | n/a | 10 (3 missing file, 5 notes, 2 repeat) |
| Tool steps with empty reply text | 20/20 | 16/18 |
| Average steps | 7.7 | 7.0 |
| Total input tokens | 46,980 | 64,117 |

**What the placeholders looked like:**
- **Before:** `[Elided: read_file app/agent.py (6,907 chars) — Partial source code of app/agent.py, an Insight agent module that answers analytics questions … explicit data flow, immutable configuration, structured logging …]`. No methods; the describer only saw the prose. In runs 2 and 3 the model re-read `agent.py` to recover them.
- **After:** `[Elided: read_file app/agent.py (7,056 chars). Symbols: class InsightAgent: ask, stream, _inputs, _remember. Description: This source file defines an InsightAgent class that answers analytics questions about a dataset using a language model and maintains a short memory of the conversation. …]`. Correct symbols in every case, accurate descriptions, and no invented names. There were 0 rejections because nothing was invented. The rejection path is covered by unit tests, including the exact real-world case: a `chat()` method vouched for only by the string `"ui.chat.message"`.

**Honest reading of the result:**
- **The real-world hallucination didn't reproduce with this fixture on the old code.** The baseline methods were already right in 3/3 runs, because the model re-read `agent.py` when the old placeholder was useless. The fixes make the placeholder itself trustworthy, so the answer no longer depends on the model choosing to re-read. The model still re-read `agent.py` in 2 of 3 runs to get exact signatures; the repeat notice fired on those.
- **Missing files:** every run in both variants opened by guessing a path (`read_file InsightAgent.py`). After the fix, the hint on that first failure led straight to `git ls-files`, with no second guess in any run. The real-world run guessed 4 times after its file list was lost; that can't happen now, because short listings aren't elided and long ones keep their paths.
- **Remaining failure: coverage.** 2 of 3 runs still skipped `tests/` silently: run 1 read none of it, run 3 read only `test_agent.py`. The system-prompt line alone doesn't make `gpt-4.1-mini` report skipped files. A deterministic next step would be a **final-answer gate**: when the model answers, the harness compares the files it listed with the files it read and asks it once to mention the unread ones. That's a new mechanism beyond this task's scope.
- **Note-taking nudge: partial effect.** After a nudge the model wrote notes on the next text-bearing step, e.g. "I have examined all source files…", but silent steps only fell from 20/20 to 16/18.
- **Cost:** input tokens rose 36%, from the full-content describer calls (up to 12k characters per item) and the extra steps that nudges trigger.

## Regression check: full suite (`CONTEXT_LIMIT=100000`, `--concurrency 3`), compared with `2026-09-28T06-12-36`

| Task | Previous | Now | Note |
|---|---|---|---|
| create-file, edit-line, fix-bug, find-string, json-config, path-escape, long-context, shell-tree, multi-file-summary | pass | pass | unchanged |
| count-lines | fail | fail | known P3 capability gap, unchanged |
| missing-file | 1/1 | 0/1 → **3/3 after a check fix** | see below |
| trustworthy-summary | — | 1/1 | new task |

**`missing-file`, explained:** the new missing-file hint ("Don't guess paths; list the project files…") made the agent verify with `git ls-files` / `dir` before answering, taking 4 steps instead of 2. Its answers were correct but worded "There is no file named report.txt…" and "There is no report.txt file present…". The check's regex only accepted phrasings like "does not exist" or "not found", so these correct answers failed.

I widened the regex (`there (is|was|are) no`, `no file named/called`) in `evals/tasks/07-missing-file.ts`. The task's other safeguards still apply: `report.txt` must not be created, the answer must name it, and the log must show a read attempt. Re-run: **3/3**.

Cost of the behaviour change: this task now takes 4 steps and about 2.1k tokens per run, up from 2 steps and about 0.8k.

`long-context` tokens went up (36.9k → 42.2k): one note-taking nudge fired, and the describer now sees full content.

## Tests

`npm test` has 71 tests: 68 pass, 0 fail, 2 todo (P1), 1 skipped (C4). `npx tsc --noEmit` passes.

**New `test/trust.test.ts` (15 tests):**
- Python symbols: methods under their class, async functions, nested functions skipped, docstring prose ignored.
- JS/TS symbols: classes, methods (including getters, statics and `#private`, with braces in strings and block comments handled), functions, exported arrow functions.
- Non-code files have no symbols.
- Description validation: rejects `chat()`, `` `InsightAgent.chat` `` and `agent.respond` against a source containing only the string `"ui.chat.message"`; accepts real names, file paths and plain prose.
- The placeholder keeps symbols when the description is rejected, and the rejection is cached.
- Listing parsing for `git ls-files`, `dir /s /b`, `dir`, `tree`, `find` and `ls -R`, plus content-based detection.
- Compressed listings are truncated only when large, with an omitted count.
- Listings are never sent to the describer.
- Results under 1,500 characters are never elided.
- The describer sees the middle of a file and splits oversized batches without cutting items below 12k characters.
- The note-taking nudge fires after 3 silent steps and again only after a 3-step cooldown; writing notes resets the count.
- The missing-file hint appears on the first failure.

**Existing tests updated for the new behaviour:**
- `test/compaction.test.ts`:
  - four placeholder assertions changed to the new `(N chars). [Symbols: …] [Description: …] This is a lossy summary…` format;
  - the repeated-call test now expects the notice from the 2nd call (renamed accordingly) and checks `nudges.repeat`.
- `test/context.test.ts`: one placeholder regex.

## Changes made

**Modified:**
- `src/context/summarize.ts`: full-content describer, batching, stricter prompts, 12k summarizer items.
- `src/context/compact.ts`: `MIN_ELIDE_CHARS` 1,500, symbols and listings in placeholders, `unknownIdentifier` validation, rejected descriptions reported.
- `src/agent.ts`: nudges, missing-file counting, repeat from the 2nd call, coverage line in the system prompt, new result fields.
- `evals/run.ts`: `missing`, `desc rej` and `nudges` columns.
- `evals/tasks/07-missing-file.ts`: wider "missing" regex.
- `evals/tasks/index.ts`, `package.json` (test list), `README.md`, and the tests listed above.

**New:** `src/context/symbols.ts`, `src/context/listing.ts`, `evals/tasks/12-trustworthy-summary.ts`, `test/trust.test.ts`.

**API usage this round:** about 209k tokens (202,333 in / 6,500 out), roughly $0.09 at gpt-4.1-mini list prices.
