---
name: bugfix-with-test
description: Fix a reported bug test-first — reproduce it with a failing test, then make the minimal fix. Use when asked to fix a bug, a wrong result, a crash or a regression in code that has (or can have) automated tests.
---

# Bug fix, test first

The new test is the proof: it goes **red** on the bug before the fix and **green** after it. A fix without a red test is a guess.

## Steps

1. **Pin down the report.** Write down the input, the expected result and the actual result, in the same message as your first tool call. If the report gives no concrete input, derive one from its description.
2. **Find the tests and the baseline.** `glob` for test files (`**/*.test.*`, `**/test_*.py`, `tests/**`) and find the test command (`scripts.test` in `package.json`, `pyproject.toml`, `Makefile`). Run the full suite once with `run_shell`. Done when you know the command and how many tests pass and fail *before* any change.
3. **Locate the code.** `grep` for the function or message named in the report; `read_file` it and its callers until you can point at the line you suspect.
4. **Write a reproducing test.** Add a *new* test — a new file, or a new case appended to the matching test file — that calls the code with the report's input and asserts the expected result. Follow the style of the existing tests.
5. **Run it and see red.** It must fail *for the reported reason* (the wrong value, the reported exception), not because of a mistake in the test. If it passes, the bug is not reproduced: try a different input from the report, at most twice, then stop (see below).
6. **Make the minimal fix** with `edit_file`: only what the root cause requires — no refactors, renames or cleanups.
7. **Run the new test, then the full suite.** The new test is green, and every test that passed in step 2 still passes. If another test breaks, the fix is wrong: change the code, not the test.
8. **Report** in the format below — only after step 7: a reply without tool calls ends the run.

## Output format

```
## Root cause
What was wrong and why, at `path:line`.

## Test added
`path` — test name; what it asserts.
Before the fix: FAIL — quote the assertion message.

## Fix
`path:line` — what changed, and why it is minimal.

## Results
New test: PASS. Full suite: N passed, M failed (baseline: N' passed, M' failed).
```

## Stop when

- **Done:** the new test was red before the fix and is green after it, and the full suite is no worse than the baseline.
- **Stop and report instead of fixing** when the bug cannot be reproduced after two attempts, or the tests cannot be run. Say what you tried and what you saw; leave the code unchanged.

## Don't

- Edit or delete existing tests, or their expected values, to make anything pass. If an existing test contradicts the reported behavior, stop and report the conflict.
- Fix before you have seen the new test fail.
- Touch code unrelated to the root cause.
