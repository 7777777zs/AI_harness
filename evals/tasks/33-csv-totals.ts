import type { EvalTask } from "../types.js";
import { fail, pass, prng, write } from "../helpers.js";

// Hard suite: an exact sum over 720 CSV rows in six files, too many to add up by eye, so the model
// has to compute it (run_shell with node, for instance). Traps: product names with a comma are
// quoted ("Cable, 2m"), so splitting on commas shifts the columns; the April file has its columns
// in a different order, so reading by position is wrong too.

const ROWS_PER_FILE = 120;
const COLUMNS = ["order_id", "date", "region", "status", "product", "quantity", "unit_price"] as const;
const APRIL_COLUMNS = ["order_id", "date", "product", "quantity", "unit_price", "region", "status"] as const;
const PRODUCTS: [string, number][] = [
  ["Widget", 1250],
  ["Gadget", 3999],
  ["Lamp", 2400],
  ["Cable, 2m", 749],
  ["Adapter, USB-C", 1995],
];
const REGIONS = ["EU", "US", "APAC"];
const STATUSES = ["shipped", "shipped", "shipped", "cancelled", "pending", "returned"];

const csvField = (v: string) => (v.includes(",") ? `"${v}"` : v);

/** The six files' contents and the EU shipped revenue in cents. */
export function buildData(): { files: Record<string, string>; euShippedCents: number } {
  const rand = prng(7);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const files: Record<string, string> = {};
  let euShippedCents = 0;
  let id = 10_000;
  for (let month = 1; month <= 6; month++) {
    const columns = month === 4 ? APRIL_COLUMNS : COLUMNS;
    const lines = [columns.join(",")];
    for (let i = 0; i < ROWS_PER_FILE; i++) {
      const [product, priceCents] = pick(PRODUCTS);
      const row: Record<string, string> = {
        order_id: `O${id++}`,
        date: `2026-${String(month).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
        region: pick(REGIONS),
        status: pick(STATUSES),
        product,
        quantity: String(1 + Math.floor(rand() * 20)),
        unit_price: (priceCents / 100).toFixed(2),
      };
      if (row.region === "EU" && row.status === "shipped") euShippedCents += Number(row.quantity) * priceCents;
      lines.push(columns.map((c) => csvField(row[c]!)).join(","));
    }
    files[`data/orders-2026-${String(month).padStart(2, "0")}.csv`] = lines.join("\n") + "\n";
  }
  return { files, euShippedCents };
}

const DATA = buildData();
/** The answer, e.g. "123456.78". */
export const EXPECTED_TOTAL = (DATA.euShippedCents / 100).toFixed(2);

export const task: EvalTask = {
  id: "csv-totals",
  description: "Hard: an exact revenue sum over 720 CSV rows; quoted commas and one file with another column order",
  prompt:
    "The CSV files in data/ hold this year's orders. What is the total revenue (quantity × unit_price) of the orders " +
    "with status shipped in region EU, across all the files? Give the exact amount.",
  suite: "hard",
  maxSteps: 30,
  setup(dir) {
    for (const [p, c] of Object.entries(DATA.files)) write(dir, p, c);
  },
  check(_dir, result) {
    // Amounts with two decimals, with or without thousands separators. The answer is the last amount
    // on a line that mentions a total (a per-file breakdown after it doesn't count); without such a
    // line, the last amount.
    const amountsIn = (s: string) => (s.match(/\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}/g) ?? []).map((a) => a.replace(/,/g, ""));
    const lines = (result.finalText ?? "").split("\n");
    const totalLines = lines.filter((l) => /total/i.test(l) && amountsIn(l).length > 0);
    const found = amountsIn(lines.join("\n"));
    const answer = (totalLines.length ? amountsIn(totalLines.at(-1)!) : found).at(-1);
    const details = { amounts: found, answer };
    return answer === EXPECTED_TOTAL ? { ...pass(), details } : { ...fail(`expected ${EXPECTED_TOTAL}; the answer's total: ${answer ?? "none"}`), details };
  },
};
