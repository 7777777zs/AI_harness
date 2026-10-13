// Hand-authored calibration examples, not model responses or a held-out benchmark.
const sql = "- src/users.js:8: SQL injection: concatenating the name into the query lets input change the SQL.";
const pagination = "- src/paginate.js:3: Off-by-one: adding 1 skips the first item on each page.";
const handle = "- src/report.js:9: The file descriptor leaks because it is never closed.";
const falseAlarm = "- src/format.js:2: The rename from value to dollars is a bug and must be reverted.";
const approval = "- src/format.js:2: The rename is harmless and has no functional impact.";
// Two blank lines between findings keep each one outside the matcher's nearby-line window of the
// next, so this set does not test findings that sit on adjacent lines.
const review = (...items: string[]) => items.join("\n\n\n");

export const reviewCalibrationCases = [
  { id: "two-real-defects", answer: review(sql, pagination), expected: true },
  { id: "three-real-defects", answer: review(sql, pagination, handle), expected: true },
  { id: "two-defects-plus-false-alarm", answer: review(sql, pagination, falseAlarm), expected: false },
  { id: "three-defects-plus-false-alarm", answer: review(sql, pagination, handle, falseAlarm), expected: false },
  { id: "harmless-rename-cleared", answer: review(sql, pagination, approval), expected: true },
  { id: "only-one-defect", answer: sql, expected: false },
  { id: "empty-answer", answer: "", expected: false },
] as const;
