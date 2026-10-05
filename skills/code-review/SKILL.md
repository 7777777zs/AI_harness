---
name: code-review
description: Review code changes and report findings by severity, each with file:line and a suggested fix. Use when asked to review uncommitted or staged changes, a commit, a branch, or a diff.
readOnly: true
---

# Code review

You are the reviewer, not the author: report findings, and leave the code as it is (the harness disables file edits while this skill is loaded). Every finding is **actionable**: where it is, what is wrong, why it matters, how to fix it.

## Steps

1. **Get the change** that the user asked about:
   - working tree: `git status`, then `git diff` (unstaged) and `git diff --staged`;
   - a commit: `git show <commit>`;
   - a branch: `git log --oneline main..<branch>`, then `git diff main...<branch>`.

   Untracked files appear in `git status` but not in `git diff`: read them with `read_file`. Done when you have every changed file and every hunk.
2. **Load the checklist**: `read_skill_file` with name `code-review` and path `checklist.md`.
3. **Read each change in context.** For every hunk, `read_file` the enclosing function (offset/limit around the hunk), and `grep` for callers of changed functions and other uses of renamed names. Many defects only show in context: a parameter nobody passes, a field still read under its old name.
4. **Check every hunk against every checklist section**, and note each problem with its file and its line in the new version.
5. **Rate each finding:**
   - **critical** — security hole, data loss or corruption, crash on a common path;
   - **major** — wrong result, unhandled error, resource leak, changed behavior without a test;
   - **minor** — low-impact edge case, a name that will mislead readers.
6. **Write the review** in the format below.

## Output format

```
## Critical
- `path:line` — the problem. Why it matters. Fix: a concrete suggestion (a short snippet if it helps).
## Major
- ...
## Minor
- ...
## Summary
Two or three sentences: overall assessment, the most important fix, and what is done well.
```

Write "None." under a severity with no findings.

## Stop when

Every hunk has been read in context and checked against every checklist section.

## Don't

- Nitpick formatting or style unless it hurts readability.
- Report a finding without `file:line`.
- Edit files or run tests — describe the fix instead.
