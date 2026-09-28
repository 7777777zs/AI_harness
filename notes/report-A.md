# Workstream A: compaction fixes (branch `compaction-fix`)

## What changed

| # | Fix | Where |
|---|---|---|
| 1 | **Pinned known files.** Paths from every listing-type result are merged, de-duplicated, restricted to real files under cwd, and have ignored dirs dropped. They are shown in a `[Harness status — not a new instruction]` message attached to **each request** (not stored in history), so they can't be elided or summarized and are always current. Above about 1,500 tokens the block switches to directories with file counts, keeping full paths for directories named in the task or containing a read file. | `src/context/coverage.ts`, `agent.ts` |
| 2 | **Harness-computed coverage.** Successful `read_file` calls are tracked, with offset/limit counted as a partial read. The status block shows `Read: N / Not yet read: M` plus the unread paths. | `coverage.ts`, `agent.ts` |
| 3 | **Level 2 rules.** The prompt puts the assistant's notes first and keeps them nearly verbatim, forbids completion claims, and ends with "Remaining work". `sanitizeSummary()` also enforces this in code: it strips completion claims, drops model-written path lists under "Remaining work", and appends the harness's `Unread files (harness-computed): …`. | `summarize.ts`, `compact.ts` |
| 4 | **Level 2 input cap.** Results with an informative Level 1 placeholder (symbols, description or paths) go to Level 2 as the placeholder. The original goes only for results that were never described. Every compaction call is logged (`describe_call`, `level2_call`, with input and output tokens), and `AgentResult.compactionUsage` has the totals. | `compact.ts` (`level2Input`), `agent.ts` |
| 5 | **Description cache by (tool, path, sha1 of content).** An unchanged file elided again under a new tool call id reuses its description with no model call; changed content is described again. | `store.ts`, `compact.ts` |
| 6 | **Coverage check.** If the model gives a final answer to a whole-project task (regex heuristic) while listed files are unread, the harness sends your follow-up message once per run and continues. Controlled by the `coverageCheck` option and `COVERAGE_CHECK=on\|off` (default on). Logged as a `coverage` nudge; `NudgeStats.coverage` holds the count. | `agent.ts` |
| 7 | **Decorated nested Python functions** are extracted as `create_app > chat [GET /chat]`. Routes are parsed from `.get/.post/.put/.delete/.patch/.head/.options/.websocket/.route(methods=…)/.api_route`. Other decorators give the name only; undecorated nested functions are still skipped; top-level decorated functions get the route suffix too. | `symbols.ts` |

## Bug found and fixed along the way

`run_shell` output is wrapped as `exit code: 0\nstdout:\n…\nstderr:\n`, and `parseListing` treated the `stdout:` line as an `ls -R` directory header. Every path got a bogus `stdout/` prefix. So:
- in the first eval runs of this round, no known files were recorded;
- in the previous round, listing placeholders for `run_shell` listings were prefixed `stdout/…`.

The unit tests missed it because they used a stub that returned a bare listing. Fixed with `shellStdout()`, applied in `isListing` and `parseListing`. The regression test uses the real result format.

## Tests

`npm test` has 84 tests: 81 pass, 0 fail, 2 todo (P1, which Workstream B is fixing), 1 skipped (C4).

**New `test/coverage.test.ts` (13 tests):**
- the pinned listing survives Level 1 and Level 2, going through the real `runAgent` loop with a mocked LLM and a stubbed shell;
- unread-list computation and updates, including Windows-style and `./` paths, partial reads and paths outside cwd;
- the size fallback;
- whole-project task detection;
- Level 2 input uses placeholders for described results;
- `sanitizeSummary`: model path lists and completion claims removed, harness list appended;
- the description cache: reused when unchanged, regenerated on change;
- the coverage check: fires once; not when everything was read; not when disabled (option or env); not for narrow tasks;
- decorated nested functions with routes;
- the `run_shell` wrapper regression.

**Changed existing test:** in `test/context.test.ts`, the exact-summary expectation now includes the trailing `Remaining work:` heading.

## Eval results (gpt-4.1-mini, 3 runs each, the tasks' own 8k context)

| Task | Pass | Avg steps | Input tokens | Compaction share of input | Level 2 acc/rej/skip | Coverage checks | Unread at end |
|---|---|---|---|---|---|---|---|
| 11 multi-file-summary | 3/3 | 3.0 | 38,463 | 0% | 0/0/0 | 0 | 0 |
| 12 trustworthy-summary | 2/3 | 8.0 | 76,506 | 18.9% | 0/0/1 | 0 | 0 |
| 17 project-overview (new) | 3/3 | 8.7 | 145,264 | 27.9% (describer 31.9k, Level 2 8.7k) | 5/0/1 | 3 | 0 |

**Task 17 `project-overview`:**
- Fixture: 24 modules plus `__init__.py`s, README and `pyproject.toml` in a git repo. FastAPI routes are nested in `create_app()`.
- Check: all 4 routes listed; every source module described, or skipped files explicitly identified; no invented paths.
- Behaviour: in every run the coverage check fired once when the model tried to finish with `tests/` unread. The model then read the remaining files, and every run ended with 0 unread.

**A real Level 2 summary from task 17:**
- "Assistant notes" come first with 12 per-file notes kept nearly verbatim.
- There are no completion claims.
- "Remaining work" ends with `Unread files (harness-computed): tests/: conftest.py, test_cache.py, test_db.py, test_main.py, test_ranking.py, test_search.py`.

**Task 12's remaining failure (1/3) is answer quality, not coverage.** The model read all 6 files (the status block went down to `Not yet read: 0`), but its final answer left out the two test files. The harness can't detect this.

**Eval-check fixes made in my own compaction tasks** (check bugs, not behaviour changes):
- Task 12: methods are now searched after every mention of `InsightAgent`; the old 1,200-char window after the first mention missed a correct list further down. A partial path of a real file such as `tests/test_db.py` is now accepted.
- Task 17: a partial path of any real file on disk (`routers/admin.py`, `__init__.py`) is accepted.

**Open point: compaction is still about 28% of input on task 17.**
- It's dominated by Level 1 describer calls, which see up to 12k characters of each file (the trustworthiness fix from the last round).
- Level 2 input is now small, thanks to fix 4.
- One option: send the describer head+tail plus the extracted symbols for code files, instead of the full content.

## For integration (Workstream B's tools)

- **Listing tools:** `isListing()` in `src/context/listing.ts` must return true by tool name for `list_dir` and `glob`. `parseListing()` must drop B's footer lines (starting with `[`, or `(empty directory)`) and strip `list_dir`'s size suffix ` (4.1 KB)` or ` (link, not followed)`. `Coverage.addListing()` then picks them up with no other change.
- **`read_file` with offset/limit:** already counted as a **partial** read (`agent.ts` checks `args.offset`/`args.limit`). Before `extractSymbols()` and the describer, the `^\s*\d+\t` line-number prefix and the `[lines A-B of T…]` footer must be stripped. Otherwise symbols are fine, but the content hash for the description cache differs per range, which is acceptable.
- **`store.label()`:** should fall back to `args.pattern` for `glob`/`grep`.
- **Eval task numbering:** A uses 17 and B uses 13–16, so `evals/tasks/index.ts` will have a trivial merge conflict.

## Also on this branch

- `README.md` context section updated: status block, coverage check, `COVERAGE_CHECK`.
- `evals/run.ts` records `compactionInputTokens` and `unreadAtEnd` per run, in the results JSON only (no table changes).
- **API usage for A's eval runs:** about 568k tokens (539,218 in / 29,191 out), roughly $0.26.
