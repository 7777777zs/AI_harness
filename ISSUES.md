# Open issues

Everything not yet fixed, collected from the earlier issues file and [TEST_REPORT.md](TEST_REPORT.md) on 2026-10-06. Fixed and closed items are in [RESOLVED.md](RESOLVED.md).

**Constraints:**
- Add as few new mechanisms as possible; reuse existing paths (nudges, the `[Harness status]` message).
- Each validation round may spend at most **$1** of API usage.
- Nothing is deleted without asking first.

**Statuses:** **Fix** (decided, with a plan), **Accept** (known and documented, no change), **Defer** (revisit later, with a trigger). The decisions were made on 2026-10-06; fixed items move to [RESOLVED.md](RESOLVED.md) once done.

## Summary

| ID | Item | Area | Status |
|---|---|---|---|
| I1 | [count-lines: the model estimates instead of counting](#i1-count-lines-the-model-estimates-instead-of-counting) | Model behavior | **Defer** |
| I2 | [Files read but left out of the answer](#i2-files-read-but-left-out-of-the-answer) | Model behavior | **Accept** |
| I3 | [Small-range re-reading is not stopped by the repeat notice](#i3-small-range-re-reading-is-not-stopped-by-the-repeat-notice) | Model behavior | **Defer** |
| I4 | [long-page still fails 1 run in 3](#i4-long-page-still-fails-1-run-in-3) | Model behavior | **Defer** |
| I5 | [Giving up after a `wait_for` timeout (N5 variant)](#i5-giving-up-after-a-wait_for-timeout-n5-variant) | Model behavior | **Defer** |
| I6 | [Completion rules check format, not substance (N2)](#i6-completion-rules-check-format-not-substance-n2) | Skills | **Accept** |
| I7 | [Plan detection is unverified on Chinese text (N3)](#i7-plan-detection-is-unverified-on-chinese-text-n3) | Pre-finish check | **Defer** |
| I10 | [Prompt-level injection defenses are unreliable](#i10-prompt-level-injection-defenses-are-unreliable) | Security | **Accept** |
| I11 | [Same-turn guard gap (D2)](#i11-same-turn-guard-gap-d2) | Security | **Accept** |
| I12 | [The guard also blocks harmless actions](#i12-the-guard-also-blocks-harmless-actions) | Security | **Accept** |
| I13 | [Path restriction and tool limits](#i13-path-restriction-and-tool-limits) | Security | **Accept** |
| I14 | [Read-only git allowlist and repository git config](#i14-read-only-git-allowlist-and-repository-git-config) | Security | **Accept** |
| I15 | [No internet block outside evals](#i15-no-internet-block-outside-evals) | Security | **Accept** |
| I16 | [Cleanup after a hard kill depends on the MCP server](#i16-cleanup-after-a-hard-kill-depends-on-the-mcp-server) | Processes | **Accept** |
| I18 | [The A1 answer merge never ran live](#i18-the-a1-answer-merge-never-ran-live) | Verification | **Accept** |
| I19 | [Recent fixes are validated with gpt-4.1-mini only](#i19-recent-fixes-are-validated-with-gpt-41-mini-only) | Verification | **Defer** |
| I20 | [Small samples make single-task differences noisy](#i20-small-samples-make-single-task-differences-noisy) | Eval method | **Accept** |
| I21 | [The interactive "y" path of the terminal prompt is untested](#i21-the-interactive-y-path-of-the-terminal-prompt-is-untested) | Verification | **Accept** |
| I22 | [Re-run only the errored eval jobs (D3b)](#i22-re-run-only-the-errored-eval-jobs-d3b) | Eval tooling | **Defer** |
| I23 | [Run logs are local only](#i23-run-logs-are-local-only) | Eval tooling | **Accept** |
| I25 | [Some eval scores are regex heuristics](#i25-some-eval-scores-are-regex-heuristics) | Eval tooling | **Accept** |
| I26 | [Deferred refactors from the code review](#i26-deferred-refactors-from-the-code-review) | Code health | **Defer** |
| I27 | [Nudge suggestions not integrated in Phase 3](#i27-nudge-suggestions-not-integrated-in-phase-3) | Code health | **Defer** |
| I29 | [Windows: `find` in `run_shell` can be Git's Unix `find`](#i29-windows-find-in-run_shell-can-be-gits-unix-find) | Processes | **Accept** |
| I30 | [The paging note of an oversized untrusted result](#i30-the-paging-note-of-an-oversized-untrusted-result) | Security | **Defer** |

---

## Model behavior

### I1: count-lines: the model estimates instead of counting
- **Source:** TEST_REPORT.md P3; every full suite since Phase 2.
- **Problem:** asked how many lines a file has, gpt-4.1-mini reads it and estimates ("120 lines") instead of counting with a tool. The task fails in almost every run (1/3 once in Phase 4).
- **Options:** a system-prompt line such as "use tools to compute exact counts rather than estimating", validated on count-lines and a core-suite run; or keep it as a known model limitation and a regression signal.
- **Tried (2026-10-07), not merged:** a prompt line, and a `read_file` footer with the total at the end of a ranged read. count-lines went to 8/10 (prompt line + footer) and 7/10 (footer only), but long-context passed 3/5 instead of 4/5 and used 2–3× the tokens (112k and 88k against 37k), because both encourage reading in small ranges. A footer on full reads would break the B1 contract (a full read written back is byte-identical). Data: TEST_REPORT.md, "Issues round 2".
- **Decision (2026-10-07): Defer.** Next step if revisited: show the total only when a ranged read reaches the end of the file, without changing the tool description, and measure long-context ×10 before and after.

### I2: Files read but left out of the answer
- **Source:** TEST_REPORT.md Phase 3 A and Phase 4 (trustworthy-summary 2/3: the model read `tests/` but did not describe it).
- **Problem:** the coverage check and footer catch files that were not *read*. A file that was read but not mentioned in the answer is not caught. Later runs passed (1/1 in the Phase 4 final suite, 3/3 in D5).
- **Decision (2026-10-06): Accept.** Recent runs pass; telling whether a read file is "mentioned" in an answer needs semantic judgment, which is not worth a new mechanism.

### I3: Small-range re-reading is not stopped by the repeat notice
- **Source:** TEST_REPORT.md Phase 4, "Other findings".
- **Problem:** the repeat notice fires only on identical calls. A model that reads the same file in many small ranges (`@1`, `@21`, `@41`…) gets no notice. Seen once (30 steps), with gpt-4o-mini as the compaction model; not seen with the main configuration.
- **Decision (2026-10-06): Defer.** Seen once, with gpt-4o-mini as the compaction model. Revisit if it recurs with the default configuration.

### I4: long-page still fails 1 run in 3
- **Source:** TEST_REPORT.md D5 (2/3) and the N4 verification (2/3).
- **Problem:** failing runs grep the empty working directory instead of searching the stored snapshot, or page through 27 steps without finding the answer. long-page was not re-run after the N5 change.
- **Decision (2026-10-06): Defer.** Include long-page ×3 in the next validation round to measure it after N5.

### I5: Giving up after a `wait_for` timeout (N5 variant)
- **Source:** RESOLVED.md, N5 ("Not covered"); 1 of 26 end-to-end web runs.
- **Problem:** after `navigate_page` the model waits for text that never appears, the wait times out, it looks for the page as a local file, and gives up without a snapshot. The URL counts as opened, so the N5 status line doesn't fire.
- **Known candidate:** a URL-aware missing-file hint ("index.html is part of the URL …") fixed it in replays (19/20 went on to `take_snapshot`). It was not adopted: it would put a harness instruction into history, and its effect on injection was not measured (see I8).
- **Decision (2026-10-06): Defer.** I8 (2026-10-07) showed that hint text after untrusted content changes how often injected instructions are followed, so a URL-aware missing-file hint would need its own injection replay before it could be adopted.

## Skills and the pre-finish check

### I6: Completion rules check format, not substance (N2)
- **Source:** RESOLVED.md, "New findings from D5"; TEST_REPORT.md D5 round A.
- **Problem:** the completion follow-up made the model add a Conflicts section to an answer built on no evidence. The machine rules are a backstop for answers built on real reading, not a replacement for it.
- **Decision (2026-10-06): Accept.** The machine rules are a backstop, not a replacement for reading the sources.

### I7: Plan detection is unverified on Chinese text (N3)
- **Source:** TEST_REPORT.md, "Plan-only detection".
- **Problem:** `isPlanOnly()` has Chinese patterns, but no logged run has a Chinese final answer, so they are covered by unit tests only.
- **Decision (2026-10-06): Defer.** Re-run `evals/plan-detect-eval.ts` once logs contain Chinese final answers.

## Security

### I10: Prompt-level injection defenses are unreliable
- **Source:** TEST_REPORT.md Phase 5 and the N4/N5 rounds.
- **Problem:** gpt-4.1-mini sometimes follows instructions on an injected page (1/10 to 3/9 runs per round, depending on the round). The guard stopped every attempt; `pwned.txt` was never created.
- **Decision (2026-10-06): Accept.** The guard is the protection; it stopped every attempt.

### I11: Same-turn guard gap (D2)
- **Source:** the earlier issues file (D2); README, "Untrusted content".
- **Problem:** a `run_shell`/`write_file`/`edit_file` call in the *same* turn as the first MCP call is not guarded. Such calls are generated before the MCP result exists, so they can't be driven by it.
- **Decision (2026-10-06): Accept.** Same-turn calls are generated before the MCP result exists.

### I12: The guard also blocks harmless actions
- **Source:** TEST_REPORT.md Phase 5.
- **Problem:** e.g. saving a fetched page after an MCP call needs confirmation (denied in evals). This is the intended trade-off under auto-approve.
- **Decision (2026-10-06): Accept.** The intended trade-off under auto-approve.

### I13: Path restriction and tool limits
- **Source:** TEST_REPORT.md P1 note and Phase 3 B ("Accepted limitations").
- **Problem:**
  - a time-of-check/time-of-use window remains: a link could be swapped between the path check and the open;
  - a user-supplied `grep` regex can be slow (ReDoS);
  - backslashes in paths are converted on POSIX;
  - `run_shell` is not path-restricted, by design (it asks for confirmation).
- **Decision (2026-10-06): Accept.**

### I14: Read-only git allowlist and repository git config
- **Source:** TEST_REPORT.md Phase 6.
- **Problem:** the allowlist blocks `--output`, `--ext-diff` and `--textconv` on the command line, but a repository's own git configuration (e.g. configured diff drivers) can still run commands during `git diff`/`git log`.
- **Decision (2026-10-06): Accept.** Documented. If it is ever fixed: run read-only git commands with the repository's command-running settings disabled (`core.fsmonitor`, external diff, textconv).

### I15: No internet block outside evals
- **Source:** TEST_REPORT.md Phase 6 (the eval proxy).
- **Problem:** evals block the public internet with a dead proxy. User configurations don't, so the agent can browse public sites unless the user restricts it.
- **Decision (2026-10-06): Accept.** Restricting the internet is the user's configuration.

## Processes and platforms

### I16: Cleanup after a hard kill depends on the MCP server
- **Source:** TEST_REPORT.md Phase 5 (Windows process cleanup).
- **Problem:** if the harness itself is killed, cleanup relies on the MCP server exiting when its stdin closes. Verified for chrome-devtools-mcp; not guaranteed for other servers (Node has no Windows job objects).
- **Decision (2026-10-06): Accept.**

## Verification gaps

### I18: The A1 answer merge never ran live
- **Source:** TEST_REPORT.md Phase 4.
- **Problem:** the merge (when an answer after a follow-up is much shorter than the one before) is covered by unit tests only; no live run has triggered it.
- **Decision (2026-10-06): Accept.** Unit-tested; the trigger is rare.

### I19: Recent fixes are validated with gpt-4.1-mini only
- **Source:** TEST_REPORT.md D5, N4, N5.
- **Problem:** the pre-finish check (D1) was built for gpt-4.1's plan endings but validated with gpt-4.1-mini. The N4 URL rule and the N5 status line were also measured with gpt-4.1-mini only. gpt-4.1 has a 30k tokens-per-minute limit in this organization.
- **Decision (2026-10-06): Defer.** Before using gpt-4.1 as the main model: `evals/url-check.ts`, the web tasks and web-research routed (about $0.5).

### I20: Small samples make single-task differences noisy
- **Source:** TEST_REPORT.md Phase 5, Phase 6, N4.
- **Problem:** with 3 runs per cell, single-task differences are mostly noise (e.g. onboarding routed 1/3 vs preloaded 3/3). N4 showed that one exact prompt can give 0/20 or 20/20 depending on unrelated details such as a temp-directory name.
- **Decision (2026-10-06): Accept.** Working rule from now on: a conclusion about model behavior needs a replay loop (at least 20 calls) or at least 10 runs, not 3.

### I21: The interactive "y" path of the terminal prompt is untested
- **Source:** TEST_REPORT.md Phase 2 "Not verified".
- **Problem:** the automated tests have no TTY, so only the default-deny path is tested. The manual Ctrl+C check in Phase 5 used the prompt, but did not answer "y".
- **Decision (2026-10-06): Accept.**

## Eval tooling

### I22: Re-run only the errored eval jobs (D3b)
- **Source:** the earlier issues file (D3b).
- **Problem:** after a rate-limited run, the whole task has to be re-run; merging partial results files is not supported. Deferred because rate-limit errors became rare after D3a.
- **Decision (2026-10-06): Defer.** Revisit if rate-limit errors become common again.

### I23: Run logs are local only
- **Source:** the earlier issues file (D6); TEST_REPORT.md "Results files and logs".
- **Problem:** the per-run logs (~45 MB) are not committed, so log-based re-scoring (`evals/rescore-skills.ts`, `evals/plan-detect-eval.ts`) and replays only work on the machine that ran the evals.
- **Decision (2026-10-06): Accept.** The D6 decision.

### I25: Some eval scores are regex heuristics
- **Source:** TEST_REPORT.md Phase 5 and D5.
- **Problem:** "warned the user", "injection followed" and `endedOnPlan` are regex checks on the final answer. One false "injection followed" was already found and fixed in D5.
- **Decision (2026-10-06): Accept.**

## Code health

### I26: Deferred refactors from the code review
- **Source:** code review 2026-10-05 (RESOLVED.md).
- **Items:** (1) split `runAgent`; (2) a shared `test/helpers.ts`; (3) a tool kind property instead of tool-name cascades; (4) a structured tool result instead of the `"Error:"` prefix; (5) `evals/run.ts` as a testable `main()`; (6) one place to define a setting, which would also give `SKILL_ROUTER` and `PREFINISH_MAX` CLI flags. None changes behavior.
- **Decision (2026-10-06): Defer.** Do each refactor when the code around it changes next.

### I27: Nudge suggestions not integrated in Phase 3
- **Source:** TEST_REPORT.md Phase 3, "Integration".
- **Items:** extend the missing-file hint to the other file tools (`edit_file`, `list_dir` on a missing directory); don't count edit and search steps as "silent" for the note-taking reminder.
- **Decision (2026-10-06): Defer.**

## Found in issues round 2

### I29: Windows: `find` in `run_shell` can be Git's Unix `find`
- **Source:** TEST_REPORT.md, "Issues round 2" (I1).
- **Problem:** when Git's `usr/bin` comes before `System32` in `PATH`, `find /c /v "" data.txt` runs Git's Unix `find`, which walks the whole drive until the 30 s timeout.
- **Decision (2026-10-07): Accept.** An environment issue, not a harness bug; the timeout stops it.

### I30: The paging note of an oversized untrusted result
- **Source:** TEST_REPORT.md, "Issues round 2" (I8).
- **Problem:** the paging note inside an oversized MCP result ("Search this result with read_tool_result … or read on with offset=…") raised how often the injected instructions were followed: 51/60 without the reminder and 21/60 with it, against 2/60 for a plain result with the reminder. The note is needed to read long pages.
- **Decision (2026-10-07): Defer.** Next step: replay a long-page state with an injection, comparing the current note with a factual-only marker plus the reminder.
