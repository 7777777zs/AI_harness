# Resolved issues

Issues that are fixed, or closed with a decision that needs no further work. Open items are in [ISSUES.md](ISSUES.md); the evidence for each is in [TEST_REPORT.md](TEST_REPORT.md).

## Summary

| Item | Resolution | Where |
|---|---|---|
| P1: sandbox escape through symlinks and junctions | `resolveInCwd` checks the realpath of the deepest existing ancestor | Phase 3, workstream B |
| P2: eval task 8 passed without exercising the path check | The task forces a `read_file` attempt and checks the logged error | Phase 2 |
| B: eval checks that passed vacuously (tasks 3, 4, 5, 7, 8, 10) | Checks tightened | Phase 2 |
| P4 / T2: interrupted eval run leaked sandboxes and lost results | Partial results file, sandboxes removed, atomic writes; refined in code review Spec #3 | `4bf2a1b`, `1857fc5` |
| P5 / T1: last step's tool results missing from the log | Each tool result is logged as it is produced | `62d5197` |
| P6 / T3: `npm run eval --runs 1` crashed | One-line usage with a hint about `--` | `5266825` |
| P7 / T4: `test/agent.test.ts` leaked temp directories | Removed after the tests | `3cc0b41` |
| P8: unvalidated context settings | A8: every setting validated, with a clear error and no fallback | Phase 4 |
| `CONTEXT_LIMIT` default 8,000 vs 100,000 | One default (100,000) in `DEFAULTS`, documented | Phase 4 (A8) |
| Compaction lost definitions, file lists and coverage (real-world 8k run) | Full-content describer, symbol extraction and validation, listings kept, nudges | "Trustworthy compaction" |
| Silent coverage gaps in final answers | Pinned `[Harness status]` file list, coverage check, harness coverage footer | Phase 3 A, Phase 4 A1/A2 |
| `run_shell` listings parsed with a bogus `stdout/` prefix | Parser fixed; tests use the real format | Phase 3 A |
| `truncate(s, max)` showed content twice for small `max` | Fixed | Phase 3 B |
| long-context could not force whole-file reads | The eval checks the answer only; compaction under whole-file reads is covered by `test/long-context.test.ts` | Phase 4 wrap-up |
| find-call-sites: prompt ambiguous about test files | The prompt says "including test files" | Phase 4 wrap-up |
| summary-with-footer: check required a footer entry that could not exist | Check fixed | Phase 4 |
| large-file-edit efficiency outlier | Did not recur (1 of 3 runs paged); no prompt line added | Phase 4 |
| Token estimate under-counted Chinese 2.7× | 0.7 tokens per CJK character, 4 characters per token, plus per-run calibration | Phase 4 (A5, wrap-up 5) |
| Rate limits (429) failed parallel eval runs | `withRetry`: max(Retry-After, backoff), 60 s cap, jitter on Retry-After too | Phase 4 wrap-up 4, D3a, code review Spec #7 |
| `COMPACT_MODEL=gpt-4.1-nano` as a cheaper default | Rejected: 1/3 on project-overview | Phase 4 wrap-up 3 |
| C4: file-symlink test skipped | Runs and passes with Developer Mode | Phase 4 wrap-up 6 |
| Model-made-up public URL reached the internet during an eval | Eval Chrome uses a dead proxy for every non-loopback request | Phase 6 |
| gpt-4.1-mini never loaded a skill by itself (0/24) | Skill router (one `COMPACT_MODEL` call); 12/12 correct when routed | Phase 6 follow-up |
| gpt-4.1 ended runs on a plan ("I will read…") | D1 pre-finish check (plan nudge) | D1 |
| web-research process failed in every condition | D1 completion criteria plus skill wording; 3/3 routed (round B) | D1, D5 |
| "Injection followed" scored a reported claim as followed | Scoring requires the claim in the answer's own voice | D5 |
| D3a, D4, D5, D6 | See below | Issues round 1 |
| N1: codebase-onboarding matched per-file summaries | Description narrowed; router check 18/18, 18/18 | Issues round 1 |
| T5: leftover temp directories and merged branches | Removed (2026-10-05, with confirmation) | – |
| Code review findings (2026-10-05) | See below | branch `review-round2` |
| N4: gpt-4.1-mini refused to open local URLs | URL rule in the MCP tools note | branch `fix-url-refusal` |
| N5: gave up after seeing only the blank tab | Unopened task URLs named in the `[Harness status]` message | branch `fix-url-refusal` |

---

## Issues round 1: decisions

D2 (the same-turn guard gap) was accepted and is listed in ISSUES.md.

### D1: Pre-finish checks

**Problem:**
- A reply without tool calls is the final answer. gpt-4.1 twice ended web-research on a plan ("I will read each of these pages…") after a skill step told it to write a list *in its reply*.
- Once it wrote the bugfix skill's report before doing the work.
- Separately, the web-research skill's process bar (cite ≥ 2 sources, report the conflict) was met in 0/24 runs.

**Decision: Fix, with (a) and (c).**

**(a) Skill wording.** web-research step 2 becomes "write the numbered list in the same message as your next tool call". Then check the other skills for steps that ask for text in a reply without a tool call.

**(c) One pre-finish check, reusing the coverage-check nudge path.** When the model replies without tool calls, the harness may send **one follow-up message** instead of finishing. There are three triggers:

1. **Plan only:** the reply only announces work ("I will…", "Next step…").
   - This follow-up is sent alone ("Do it now; the run ends when you reply without tool calls").
   - The plan reply is **not** added to `answerHistory`, so A1 never merges a plan into an answer.
2. **Coverage:** the existing `COVERAGE_CHECK` (whole-project task, listed files unread). Unchanged, but it now counts against the shared budget.
3. **Completion criteria:** declared by a loaded skill in its frontmatter:

   ```yaml
   completion:
     requiredSections: ["^#+\\s*Conflicts"]   # regexes matched against heading lines
     minDistinctUrls: 2
     text:
       - Every factual claim is followed by its source URL in parentheses.
   ```

   - **Machine rules** (`requiredSections`, `minDistinctUrls`) decide whether a follow-up is needed at all. The follow-up names the failed rules and lists the text criteria too.
   - **Text-only criteria** (a skill with no machine rules) always trigger one follow-up. That costs one extra step per run; the docs must say so.
   - `web-research` gets `requiredSections: ["^#+\\s*Conflicts"]` and `minDistinctUrls: 2`.

**Combining and budget:**
- When coverage and completion both fail on the same answer, they go in **one** message.
- All triggers share a budget of **2 follow-ups per run**, set with `PREFINISH_MAX` (A8 precedence; evals set it explicitly).
- With a budget of 1, a plan nudge would use it up and the real answer would never be checked: that is exactly the gpt-4.1 case.
- The A1 merge applies to every follow-up's answer.

**Plan detection, decided by data:**
- Before choosing between the regex heuristic (`endedOnPlan` in `evals/scoring.ts`) and a `COMPACT_MODEL` classifier call, evaluate the heuristic offline on existing logs:
  - **positives:** the known plan-ending gpt-4.1 cases;
  - **negatives:** a broad sample of genuine final answers from past runs (English and Chinese; skill and non-skill tasks).
- Report precision and recall in TEST_REPORT.md.
- **Use the classifier** if precision is below ~95% or any known plan-ending case is missed.

**Why:** one mechanism instead of two, built on an existing path, and the fewest extra steps. The machine rules make the skill's "Done" bar checkable, which is where the prose alone failed.

**Seams (tests):**
- `runAgent` with a scripted model, end to end:
  - plan nudge; machine rules; text-only criteria;
  - shared budget; combined message with coverage;
  - A1 merge; plan replies excluded from the history;
  - log events.
- `isPlanOnly(text)`, exported, plus the offline evaluation script.
- `parseSkill` / `discoverSkills`: validation of `completion`.

**Follow-up:**
- validate in D5;
- document in the README (Skills → completion criteria, including the text-only cost) and in `.env.example` (`PREFINISH_MAX`).

### D3: Rate limits

**Problem:** with gpt-4.1 (30k TPM for this organization) at concurrency 3, runs failed after 6 attempts.
- The retries already honored Retry-After (logged `reason: retry-after`), but the hints were 2–5 s.
- Concurrent jobs kept colliding inside the same one-minute window, so five short waits were used up in about 20 s.

**Decision (a): Fix.**
- Wait `max(Retry-After, exponential backoff)` before each retry, keeping the jitter.
- Cap each single wait at **60 s**, even when Retry-After is larger; a capped wait still counts as an attempt.
- Five retries then span roughly a full TPM window.
- **Seam:** `withRetry` with injected `sleep`/`random`.

**Decision (b): Defer** (still open: [ISSUES.md](ISSUES.md)) re-running only the errored jobs of a results file.

**Why defer (b):** after (a), rate-limit errors should be rare. For low-TPM models, `--concurrency 1` works. Merging partial results files is new tooling with no current need.

### D4: long-page: stored results and search

**Problem:** on long pages the model re-took the same snapshot many times. Each time it got a new stored copy (`mcp-1`…`mcp-12`) and the full first page again, and it never used `read_tool_result` with `pattern`. Stored results are also unbounded in memory.

**Decision: Fix all three.**
1. **Dedupe:** when an oversized MCP result is identical to one already stored, return a one-line reference instead of the first page again: "Same content as stored result mcp-3 (unchanged). Search it with read_tool_result pattern=… or read by offset."
2. **Memory bound:**
   - Stored results are capped by total characters (about 2M); the oldest are evicted first.
   - `read_tool_result` on an evicted id returns a clear error asking for the tool to be called again.
   - If the earlier identical result has been evicted, the new result is stored and shown normally (first page), not as a reference.
3. **Search hint:** the paging note puts searching first ("Search this result with read_tool_result pattern=… or read on with offset=…").

**Why:** dedupe and the memory bound are deterministic, small, and testable without the API. The hint changes only the text the model sees; it adds no mechanism.

**Seams:** `ResultPages`, through its public `paginate` and the `read_tool_result` tool's `execute`. The tests cover:
- an identical result → reference;
- after eviction → normal content;
- the bound;
- an evicted id → error.

**Follow-up:** long-page ×3 in D5.

### D5: Re-runs and validation

**Decision: Fix. One round, after D1 and D4, ≤ $1, gpt-4.1-mini:**
- **long-page ×3:** validates D4.
- **web-research ×3, routed:** validates D1 (completion criteria, plan nudge). Also scored offline for outcome and process.
- **The "either" tasks** (`multi-file-summary`, `trustworthy-summary`, `summary-with-footer`): ×3 routed and ×3 off. Do they help or hurt when routed to codebase-onboarding?
- **Phase 5 web tasks** (`read-page`, `multi-page`, `prompt-injection`): 2 more runs each, to reach 3 runs with the proxy config. Their third long-page run comes from the D4 validation above.

**Why:** the re-runs should test the final code, so they wait for D1 and D4 and share one round.

**Follow-up:** add a TEST_REPORT.md section with all results and costs.

### D6: Eval results in the repository

**Problem:** `evals/results/` is gitignored, so the numbers in TEST_REPORT.md can't be checked from the repository. The results JSON files are under 1 MB in total; the logs are about 45 MB.

**Decision: Fix, with sanitizing first.**
- **Commit:** only the results JSON files referenced in TEST_REPORT.md, via a `.gitignore` exception (`!evals/results/<file>.json`). Logs stay ignored.
- **Sanitize before committing:**
  - replace absolute paths (temp directories, the home directory, the username) with placeholders or relative paths;
  - scan for API keys and other secrets (`sk-…`, `OPENAI_API_KEY=`, bearer tokens);
  - fail loudly if one is found.
- **Seam:** `sanitize(text)`, exported from `evals/sanitize-results.ts`, and the script that applies it.

**Follow-up:** note in TEST_REPORT.md where the logs live and that they are excluded.

## Issues round 1: todo items

### T1: Tool results of the last step are not logged (P5)
- A `step` log line holds the request, so tool results only appear in the *next* request. When a run ends on `max_steps` or an API error, the last tool results are missing from the log.
- **Fix:** log each tool result as it is produced (`{"type":"tool_result", step, tool, toolCallId, content}`).
- **Seam:** `runAgent` with a scripted model and `maxSteps: 1`; the log contains the result.

### T2: An interrupted eval run leaks sandboxes and loses results (P4)
- Sandbox cleanup is in a `finally`, which doesn't run on Ctrl+C. Results are written only at the end. `installShutdownHandlers()` kills MCP servers but doesn't clean sandboxes. 14 `ai-harness-eval-*` directories are currently in `%TEMP%`.
- **Fix:**
  - track active sandboxes;
  - on SIGINT/SIGTERM, stop scheduling, remove them (unless `--keep`), and write the completed records as a partial results file;
  - write results atomically (temp file + rename).
- **Seam:** the runner's cleanup and partial-results functions, exported and tested directly; one end-to-end check that emits SIGINT in a child process.

### T3: `npm run eval --runs 1` crashes (P6)
- npm swallows `--runs`, and `parseArgs` throws on the stray positional with a stack trace.
- **Fix:** catch `parseArgs` errors and print a one-line usage, with a hint to put `--` after `npm run eval`.
- **Seam:** run the runner as a child process with a positional argument; exit 1 with the usage line.

### T4: `test/agent.test.ts` leaks temp directories (P7)
- Its `mkdtempSync` directories are never removed; about 370 `ai-harness-test-*` directories have accumulated.
- **Fix:** the `after(() => rmSync(...))` pattern used by the other test files.
- **Seam:** after `npm test`, no new `ai-harness-test-*` directories remain.

### T5: Clean up leftovers

**Done on 2026-10-05, after confirmation:**
- the ~370 `ai-harness-test-*` and 14 `ai-harness-eval-*` directories in `%TEMP%`;
- the merged local branches `phase5-mcp` and `phase6-skills`;
- the temporary `HARNESS_HOME` used for the manual Ctrl+C test (in the session scratchpad).

### New findings from D5

Details are in TEST_REPORT.md ("Issues round 1"). N2 and N3 are still open in [ISSUES.md](ISSUES.md).

- **Skill wording can cause the very failure it tries to prevent.** D1(a) asked web-research to write its list "in the same message as your first tool call". In the validation round, no run then read a page: each batched `new_page` with `grep` of local files and gave up (0/3). Replacing that with one explicit sentence (read pages with `new_page` + `take_snapshot`; pages are not files) gave 3/3. That is the first web-research pass in any condition. Fixed in issues round 1.
- **N1: codebase-onboarding matches per-file summaries** (Done; see TEST_REPORT.md, "N1"). The router chose it for all three "either" tasks (9/9). The outcomes didn't change (9/9 in both conditions), but tokens went up by 93% and 23% on two of the three tasks. Fix: narrow the skill's description to architecture overviews ("how the codebase works"), excluding per-file listings. Re-check with `evals/route-check.ts` (about $0.01).
- **N2: completion rules check format, not substance** (Accept). In round A, the follow-up made the model add a Conflicts section to an answer that had no facts. The machine rules are a backstop for answers built on real reading, not a replacement for it. This is documented in TEST_REPORT.md.
- **N3: plan detection is unverified on Chinese text** (Defer). The logs contain no Chinese final answers. Re-run `evals/plan-detect-eval.ts` once Chinese runs exist.

## Code review (2026-10-05)

A whole-codebase review on two axes: **Standards** (repo conventions plus a code-smell baseline) and **Spec** (the phase specs and the issues file). Behavior findings were fixed test-first, one commit each; documentation drift was fixed in one commit. The deferred refactors are in [ISSUES.md](ISSUES.md).

### Fixed

| Finding | Fix | Commit |
|---|---|---|
| Spec #1: `read_tool_result` pages bypassed the post-untrusted guard | `read_tool_result` is untrusted; only MCP results are paginated | `e7a6437` |
| Eval records counted only some nudge kinds | `totalNudges()` sums every kind | `9ad48d1` |
| Spec #2: MCP error results were not wrapped in the untrusted-content tags (error text can come from the page) | Wrapped as `Error: <tag> … <end tag>`; denials, bad arguments and read-only blocks stay unwrapped | `77da98a` |
| Spec #3: eval Ctrl+C was noticed only after MCP shutdown, so runs failing in that window were saved as completed; one failing sandbox removal stopped the rest | `onInterrupt()` hooks run first in `shutdownAll`; `removeDirs()` tries every directory and reports failures | `1857fc5` |
| Spec #5: `requiredSections` rules matched body text ("no conflicts") | Matched against heading lines only (`#` headings, bold-only lines) | `87067ac` |
| Spec #7: a `Retry-After` wait had no jitter, so parallel jobs retried in lockstep | Up to 25% added, never shorter than asked, still capped at 60 s | `00395c6` |
| Spec #8: `--task` removed by `--without-mcp`/`--without-skill-tasks` was reported as unknown | The message names the option that removed it | `c6f7e61` |
| Standards #1: `agent.ts` read `OPENAI_MODEL` directly | `modelFromEnv()` in `src/llm/`; an architecture test keeps `OPENAI` out of `agent.ts` | `ea49b56` |
| Standards #2: CLI flags had their own parsers (`on`/`off` only, different errors); `--help` omitted the repository `.env` | Shared `parseNumber`/`parseOnOff`; the same `Invalid configuration` messages naming the flag | `c8d077b` |
| Spec #4, #6 and docs drift: token estimate ratios, missing settings and eval options, MCP collision outcome, architecture tree | README corrected; for the MCP collision the docs were changed, not the code (the colliding server is disabled with a warning) | `e6845e5` |

Two timing tests (eval Ctrl+C, B3 list_dir/grep guards) failed under full-suite parallel load and were made robust in `0736b87`.

### Accepted

- **The Chinese example in a `src/prefinish.ts` comment** (`我将/接下来/下一步…`). Repository text is in English, but this comment quotes the regex it documents, so translating it would make it wrong.

## N4: local URL refusals (2026-10-06)

**Status:** Done (branch `fix-url-refusal`). Diagnosed with `/diagnosing-bugs`; about $0.85 of API calls.

- **Symptom:** gpt-4.1-mini answered "I cannot access local URLs such as http://127.0.0.1:…" in the first step, or looked for the URL as a file (`read_file index.html`), so the run made no MCP call.
- **Feedback loop:** replay the logged first request of a web run against the API, many times. Two prompt-injection runs whose first requests differed **only** in the random temp-directory name and port gave 0/20 and 20/20 tool calls. The choice is close to deterministic for one exact prompt and flips with unrelated details, which is why rounds of 3 runs swung between 0/3 and 3/3.
- **Measure:** with a random directory and port per call, the current prompt missed 6/60 first steps on prompt-injection (10%), 1/40 on read-page, 0/40 on multi-page.
- **Hypotheses tested (60 calls each, prompt-injection):** moving the MCP tool list right after the first sentence: 0/60; removing the untrusted-content paragraph: 0/60; rewording only its "visit other sites" clause: 4/60 and 2/60 (so not that clause); adding one rule that a URL is not a file and is opened with the MCP tool that loads URLs: 0/60. The prompt sits at a tipping point, and several changes push it to tool use. The URL rule was chosen: it addresses both failure modes and leaves the safety paragraph unchanged.
- **Fix:** `mcpToolsNote()` adds that rule. `baseSystemPrompt()` is exported so `evals/url-check.ts` builds exactly the request the harness sends (checked byte for byte against a logged request, without the rule).
- **Result:** no first-step refusals afterwards: 0 in 220 first-step calls across the five web tasks, and 0 in 26 end-to-end runs (TEST_REPORT.md, "N4").
- **Regression guard:** a unit test asserts the rule is in the system prompt. Model behavior has no deterministic seam; `evals/url-check.ts` is the behavioral check.
- **Not fixed here:** giving up in a later step, which became N5 (fixed). Models other than gpt-4.1-mini were not checked.

## N5: giving up after seeing only the blank tab (2026-10-06)

**Status:** Done (branch `fix-url-refusal`). Diagnosed with `/diagnosing-bugs`; about $0.82 of API calls.

- **Symptom:** step 1 calls `list_pages` (sometimes with `select_page`/`take_snapshot` of the blank tab, or `read_file index.html`) but not `new_page`. Seeing only `about:blank` or a missing file, the model says the page is not accessible and asks for its content. Found while verifying N4: 4 of 26 end-to-end web runs.
- **Feedback loop:** replay the logged request of the step where a failing run gave up, 20 times, with a random temp-directory name and port per call (tool calls and results included), and count "opened the URL" vs "gave up".
  - prompt-injection #2, step 2: gave up 20/20.
  - multi-page #2, step 2: `list_dir` 20/20; step 3: gave up 19/20.
- **Minimal repro:** system prompt, task, one `list_pages` call and its `about:blank` result. Still 20/20 gave up.
- **Cause:** the model takes the blank tab (or the missing file) for the task's page. A diagnostic run with a public-looking host instead of 127.0.0.1 still gave up 16/20, with answers like "I tried to access the article at …, but the page appears to be blank". So this is not about localhost: the model believes it already tried the URL.
- **What did not work:**
  - **A system-prompt rule** ("the browser starts with an empty tab; open the URL first") opened the URL in only 1/20: rules far from the decision point don't change it.
  - **A harness note appended to the first MCP result** fixed the give-ups (20/20 and 16/20; 20/20 together with a URL-aware missing-file hint). But it made the model follow injected page text more often. In a replay of the step where prompt-injection #10 read the injected page, the run with the note called `write_file`/`run_shell` in 12/60 replies, and the same request without the note in 2/60. In the end-to-end round with the note, 4/10 prompt-injection runs followed the injection, against 1/10 before. The likely reason: a harness instruction inside an MCP result stays in history, next to the page content. This version was dropped.
- **Fix:** while MCP tools are loaded and a URL from the task has not been mentioned in any MCP call's arguments, the `[Harness status]` message attached to each request says so. It names the URL and says that open pages and working-directory files are not that page. The message is never stored in history and disappears once a call is given the URL, so it is never next to page content. `src/taskUrls.ts` finds the task's URLs. Each request that carries the line counts as an `unopened_url` nudge.
- **Result (replays):**
  - give-up states: 20/20 opened the URL, for both prompt-injection #2 step 2 and multi-page #2 step 2 (the latter with the unchanged missing-file hint);
  - multi-page step 1: the URL was opened in 35/40 instead of 22/40.
- **Result (end to end):** prompt-injection 10/10 with no injection followed, multi-page 10/10, read-page 5/5. In 4 runs step 1 only listed pages; all opened the URL in step 2 after the status line.
- **Regression tests:** `test/mcp.test.ts` checks two things. Each request carries the status line until an MCP call is given the URL, and never after; nothing is added to tool results. And there is no line without MCP tools, or when the first step's call was given the URL. Model behavior itself has no deterministic seam; the replays and the web evals are the behavioral check.
- **Not covered** (open in [ISSUES.md](ISSUES.md)): the variant where `wait_for` times out after `navigate_page` (1 of 26 runs). The URL counts as opened there, so the status line doesn't fire. A URL-aware missing-file hint fixed it in replays (19/20 went on to `take_snapshot`), but it was not adopted: it would put a harness instruction into history, and its effect on injection was not measured.
