# Code-review grader calibration

## Problem

The review fixture contains three planted defects and one harmless local-variable rename in `format.js`. The scorer already exposed `renameFlagged`, but `outcome` only required two planted defects to be found. The task checked this outcome and an unchanged working tree. An answer containing two real findings plus the known false alarm therefore passed.

## Change

The outcome now requires `found.length >= 2 && !renameFlagged`, in `scoreCodeReview` only; the task reads `score.outcome` and reports low recall and the rename false alarm as separate reasons. Other unmatched findings remain diagnostic observations: possible false positives that have not been individually adjudicated.

## Reproducible experiment

```
npx tsx evals/review-calibration.ts           # or: npm run eval:calibrate
npx tsx evals/review-calibration.ts --json
node --import tsx --import ./test/setup.ts --test test/eval-scoring.test.ts
```

The seven hand-authored examples include two and three correct findings, each with a false-alarm variant, explicit approval of the harmless rename, insufficient recall, and an empty answer. Both rules use the same defect matcher and the same input text. The legacy column applies the historical recall-only predicate; it does not run an old checkout.

| Metric | Legacy rule | Current rule |
| --- | --- | --- |
| Agreement with authored labels | 5/7 | 7/7 |
| Incorrect accepts | 2 | 0 |
| Incorrect rejects | 0 | 0 |

The saved results (`review-calibration-2026-10-13.json`) record the commit they were run on, plus sha256 hashes of `evals/scoring.ts` and of the cases. Both hashes are taken over LF line endings, so they are the same on a CRLF and an LF checkout. Run the script on a clean checkout of that commit to reproduce them.

An integration test runs the real task checker on a scripted agent response. It checks four things: a false alarm is rejected, a clean review is accepted, low recall and the false alarm are reported separately, and the working tree is left unchanged. None of these tests call a model API.

## Historical results

Every recorded code-review run in TEST_REPORT.md has the rename flagged in 0 runs, so re-scoring them with the new rule gives the same outcomes. Results graded from now on use the new rule; a future run that flags the rename would have passed before and fails now.

## Limits

- The cases were constructed for this bug and are not a held-out sample.
- Two blank lines separate the findings in each case, so no case tests findings on adjacent lines, where the matcher's nearby-line window could mix them up.
- Matching still uses words and nearby lines. It is not a general semantic judge and does not establish robustness to arbitrary formatting or negation.
- This does not fix keyword-only grading in other tasks or validate every code-review finding.
- This is a grader correction, not an improvement in model task performance.
- The runner's automatic previous-file comparison does not check that two runs used the same configuration, so it is not a controlled performance comparison.

A useful next step is to calibrate the grader against independently labeled real answers and error cases before spending on a larger model comparison.
