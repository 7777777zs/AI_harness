# Open issues and decisions

The decisions below come from a review of the open issues after Phase 6 (2026-10-05). Background and data are in [TEST_REPORT.md](TEST_REPORT.md).

**Constraints:**
- Add as few new mechanisms as possible; reuse the existing nudge path (the coverage check in `src/agent.ts`).
- Each validation round may spend at most **$1** of API usage.
- All work happens on branch `issues-round1`.

**Statuses:** **Fix** (decided, with a plan), **Accept** (known and documented, no change), **Defer** (revisit later), **Todo** (the fix is already clear), **Done** (implemented; commit given). The **Order** column gives the suggested implementation order. The **Skill** column names the workflow to use: `/tdd` for red → green against the agreed seams, `/diagnosing-bugs` when the cause still needs finding.

## Summary

| Order | Item | Status | Skill |
|---|---|---|---|
| 1 | [D3a: retry waits: max(Retry-After, backoff)](#d3-rate-limits) | Done (`f8c075d`) | /tdd |
| 2 | [D4: long-page: dedupe stored results, memory bound, search hint](#d4-long-page-stored-results-and-search) | Done (`a3e2691`) | /tdd |
| 3 | [D1: pre-finish checks (plan nudge, completion criteria, coverage) + skill wording](#d1-pre-finish-checks) | Done (`d4d37d9`, `067be38`, `c40a77b`; wording fixed in D5) | /tdd |
| 4 | [T1: log tool results as they are produced (P5)](#t1-tool-results-of-the-last-step-are-not-logged-p5) | Done (`62d5197`) | /tdd |
| 5 | [T2: interrupted eval run leaks sandboxes, loses results (P4)](#t2-an-interrupted-eval-run-leaks-sandboxes-and-loses-results-p4) | Done (`4bf2a1b`) | /tdd |
| 6 | [T3: `npm run eval --runs 1` crashes (P6)](#t3-npm-run-eval---runs-1-crashes-p6) | Done (`5266825`) | /tdd |
| 7 | [T4: `test/agent.test.ts` leaks temp directories (P7)](#t4-testagenttestts-leaks-temp-directories-p7) | Done (`3cc0b41`) | /tdd |
| 8 | [D6: commit sanitized eval result files](#d6-eval-results-in-the-repository) | Done (`6774853`) | /tdd |
| 9 | [D5: validation and re-runs (one round, ≤ $1)](#d5-re-runs-and-validation) | Done ($0.46; see TEST_REPORT.md) | — |
| 10 | [D2: same-turn guard gap: document](#d2-same-turn-guard-gap) | Accept, documented (`86217b8`) | — |
| – | [N1: codebase-onboarding matches per-file summaries](#new-findings-from-d5) | Done (description narrowed; router check 18/18, 18/18) | — |
| – | [N2: completion rules check format, not substance](#new-findings-from-d5) | Accept, documented | — |
| – | [N3: no Chinese final answers to evaluate plan detection on](#new-findings-from-d5) | Defer | — |
| – | [D3b: re-run only errored eval jobs](#d3-rate-limits) | Defer | — |
| – | [T5: clean up leftovers](#t5-clean-up-leftovers) | Todo (needs confirmation) | — |
| – | [Code review: behavior and docs findings](#code-review-2026-10-05) | Done (branch `review-round2`) | /tdd |
| – | [Code review: deferred refactors](#deferred-refactors) | Defer (next round) | — |
| – | [N4: gpt-4.1-mini refuses to open local URLs](#n4-local-url-refusals-2026-10-06) | Done (branch `fix-url-refusal`) | /diagnosing-bugs |
| – | [N5: gives up after seeing only the blank tab](#n5-giving-up-after-seeing-only-the-blank-tab-2026-10-06) | Todo | /diagnosing-bugs |
| – | [Accepted limitations](#accepted-limitations) | Accept | — |

---

## D1: Pre-finish checks

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

## D2: Same-turn guard gap

**Problem:** the untrusted-content guard confirms the next `run_shell`/`write_file`/`edit_file` after the model has *received* MCP content. Calls issued in the same turn as the MCP call (e.g. `curl` of the same URL next to `new_page`) are not guarded.

**Decision: Accept.**

**Why:** same-turn calls are generated before the MCP result exists, so they can't be driven by instructions inside it. Results from earlier turns are already covered by the guard. Guarding same-turn calls would only add confirmations to harmless parallel calls.

**Follow-up:** document this in the README's security section (Untrusted content), with the reasoning.

## D3: Rate limits

**Problem:** with gpt-4.1 (30k TPM for this organization) at concurrency 3, runs failed after 6 attempts.
- The retries already honored Retry-After (logged `reason: retry-after`), but the hints were 2–5 s.
- Concurrent jobs kept colliding inside the same one-minute window, so five short waits were used up in about 20 s.

**Decision (a): Fix.**
- Wait `max(Retry-After, exponential backoff)` before each retry, keeping the jitter.
- Cap each single wait at **60 s**, even when Retry-After is larger; a capped wait still counts as an attempt.
- Five retries then span roughly a full TPM window.
- **Seam:** `withRetry` with injected `sleep`/`random`.

**Decision (b): Defer** re-running only the errored jobs of a results file.

**Why defer (b):** after (a), rate-limit errors should be rare. For low-TPM models, `--concurrency 1` works. Merging partial results files is new tooling with no current need.

## D4: long-page: stored results and search

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

## D5: Re-runs and validation

**Decision: Fix. One round, after D1 and D4, ≤ $1, gpt-4.1-mini:**
- **long-page ×3:** validates D4.
- **web-research ×3, routed:** validates D1 (completion criteria, plan nudge). Also scored offline for outcome and process.
- **The "either" tasks** (`multi-file-summary`, `trustworthy-summary`, `summary-with-footer`): ×3 routed and ×3 off. Do they help or hurt when routed to codebase-onboarding?
- **Phase 5 web tasks** (`read-page`, `multi-page`, `prompt-injection`): 2 more runs each, to reach 3 runs with the proxy config. Their third long-page run comes from the D4 validation above.

**Why:** the re-runs should test the final code, so they wait for D1 and D4 and share one round.

**Follow-up:** add a TEST_REPORT.md section with all results and costs.

## D6: Eval results in the repository

**Problem:** `evals/results/` is gitignored, so the numbers in TEST_REPORT.md can't be checked from the repository. The results JSON files are under 1 MB in total; the logs are about 45 MB.

**Decision: Fix, with sanitizing first.**
- **Commit:** only the results JSON files referenced in TEST_REPORT.md, via a `.gitignore` exception (`!evals/results/<file>.json`). Logs stay ignored.
- **Sanitize before committing:**
  - replace absolute paths (temp directories, the home directory, the username) with placeholders or relative paths;
  - scan for API keys and other secrets (`sk-…`, `OPENAI_API_KEY=`, bearer tokens);
  - fail loudly if one is found.
- **Seam:** `sanitize(text)`, exported from `evals/sanitize-results.ts`, and the script that applies it.

**Follow-up:** note in TEST_REPORT.md where the logs live and that they are excluded.

---

## Todo (the fix is already clear)

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
**Needs confirmation before deleting anything:**
- the ~370 `ai-harness-test-*` and 14 `ai-harness-eval-*` directories in `%TEMP%`;
- the merged local branches `phase5-mcp` and `phase6-skills`;
- the temporary `HARNESS_HOME` used for the manual Ctrl+C test (in the session scratchpad).

---

## New findings from D5

Details are in TEST_REPORT.md ("Issues round 1").

- **Skill wording can cause the very failure it tries to prevent.** D1(a) asked web-research to write its list "in the same message as your first tool call". In the validation round, no run then read a page: each batched `new_page` with `grep` of local files and gave up (0/3). Replacing that with one explicit sentence (read pages with `new_page` + `take_snapshot`; pages are not files) gave 3/3. That is the first web-research pass in any condition. Fixed on this branch.
- **N1: codebase-onboarding matches per-file summaries** (Todo, `/tdd`). The router chose it for all three "either" tasks (9/9). The outcomes didn't change (9/9 in both conditions), but tokens went up by 93% and 23% on two of the three tasks. Fix: narrow the skill's description to architecture overviews ("how the codebase works"), excluding per-file listings. Re-check with `evals/route-check.ts` (about $0.01).
- **N2: completion rules check format, not substance** (Accept). In round A, the follow-up made the model add a Conflicts section to an answer that had no facts. The machine rules are a backstop for answers built on real reading, not a replacement for it. This is documented in TEST_REPORT.md.
- **N3: plan detection is unverified on Chinese text** (Defer). The logs contain no Chinese final answers. Re-run `evals/plan-detect-eval.ts` once Chinese runs exist.

## Code review (2026-10-05)

A whole-codebase review on two axes: **Standards** (repo conventions plus a code-smell baseline) and **Spec** (the phase specs and this file). Behavior findings were fixed test-first, one commit each; documentation drift was fixed in one commit. Refactors (code smells) are deferred to a later round.

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

### Deferred refactors

None of these changes behavior; each is worth doing when the code around it changes next.

1. **Split `runAgent`** (`src/agent.ts`). It holds the loop, tool execution, the guard, pre-finish checks and logging in one long function. Reason to defer: it works and is well covered by tests; splitting it touches every agent test's assumptions at once.
2. **A shared `test/helpers.ts`** for the duplicated `scripted`, `tmp`, `logOf` and `fakeClient` helpers (`fakeApi` already moved to `test/fake-api.ts`). Reason to defer: mechanical churn across many test files.
3. **A tool kind property** instead of `if` cascades on tool names (`read_file`, `list_dir`, `glob`, …) in `agent.ts`, compaction and listing detection. Reason to defer: the cascades are few and tested; a property is the right fix once another tool joins them.
4. **A structured tool result** (`{ ok, text }`) instead of the `"Error:"` string prefix that `agent.ts` and `context/budget.ts` test for. Reason to defer: it changes the `Tool` interface and every tool.
5. **`evals/run.ts` as a testable `main()`**, instead of a top-level script that tests can only run as a child process. Reason to defer: the child-process tests cover it today.
6. **One place to define a setting.** A new setting now needs edits in `config.ts` (`SettingOverrides`, `HarnessConfig`, `ENV_NAMES`, `DEFAULTS`, `resolveConfig`, `describeConfig`), `index.ts` (flag and USAGE), `.env.example` and the README. A single settings table would remove that, and would also give `SKILL_ROUTER` and `PREFINISH_MAX` CLI flags, which they lack today.

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
- **Not fixed:** giving up in a later step, which is now N5. Models other than gpt-4.1-mini were not checked.

## N5: giving up after seeing only the blank tab (2026-10-06)

**Status:** Todo (`/diagnosing-bugs`). It was found while verifying N4: 4 of 26 end-to-end web runs.

- **Symptom:** step 1 calls `list_pages` (sometimes with `select_page`/`take_snapshot` of the blank tab, or `read_file index.html`) but not `new_page`. Seeing only `about:blank`, the model says the page is not accessible and asks for its content. In one variant, `wait_for` times out after `navigate_page`, and the model gives up without a snapshot.
- **Rate:** step 1 doesn't open the URL in 9/40 (multi-page) and 5/40 (prompt-injection) calls. Most of those runs still open it in step 2; the failures are the ones that stop there.
- **Feedback loop to build:** replay the logged step-2 request (the `list_pages` result showing only `about:blank`) with a random port, and count "gave up" vs "opened the URL".
- **Candidate fixes to test:** state in the URL rule that the browser starts with a blank tab, so a listed page or snapshot says nothing about the URL; or, harness-side, mention the task's URL in the `list_pages` result when it is not open.

## Accepted limitations

These are documented in the README or TEST_REPORT.md; there is no change planned.

- **Prompt-level injection defenses:** not reliable with gpt-4.1-mini. The guard is the real protection: 8 of 8 attempted actions after injected content were stopped.
- **Read-only git allowlist:** it doesn't cover a repository's own git configuration (e.g. configured diff drivers).
- **Hard kill of the harness:** cleanup depends on the MCP server exiting when its stdin closes. Verified for chrome-devtools-mcp, not guaranteed for other servers (Windows has no job objects in Node).
- **The guard also blocks harmless actions** after MCP content (e.g. saving a fetched page). That is the intended trade-off under auto-approve.
- **No internet block outside evals:** evals block the public internet with a dead proxy. User configurations don't, so the agent can browse public sites unless the user restricts it.
- **Model limits (gpt-4.1-mini):**
  - `count-lines` (P3): it estimates instead of counting;
  - ~~it refuses to open local URLs (21 of 54 Phase 5 web runs made no MCP call)~~: fixed, see [N4](#n4-local-url-refusals-2026-10-06);
  - small samples (3 runs per cell) make single-task differences noisy.
- **Not verified:**
  - process-group cleanup (A7) and the MCP transport on Linux/macOS;
  - the A1 merge in a live run (unit tests only).
