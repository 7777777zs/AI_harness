import type { EvalTask } from "../types.js";
import { fail, pass, prng, write } from "../helpers.js";

// Hard suite: a ~230k-character log (about 57k tokens, twice a 30k context) where the answer is a
// join: payment failures with code E42 (they carry the user) and later successful retries (they
// carry only the transaction). Reading the file is not possible; it has to be searched. Decoys:
// failures never retried or retried without success, refunds with E42, E17 and E420 failures, and
// a user whose E42 transaction was never retried while another of their transactions was.

const NOISE_LINES = 2_700;

type Event = { event: string; user?: string; txn: string; code?: string };

/** Each story: events in order. `expected` users had an E42 payment failure later retried successfully. */
const STORIES: { user: string; expected: boolean; events: Event[] }[] = [
  { user: "U5108", expected: true, events: [{ event: "payment_failed", user: "U5108", txn: "T70411", code: "E42" }, { event: "payment_retry_ok", txn: "T70411" }] },
  { user: "U5233", expected: true, events: [{ event: "payment_failed", user: "U5233", txn: "T70519", code: "E42" }, { event: "payment_retry_ok", txn: "T70519" }] },
  { user: "U5371", expected: true, events: [{ event: "payment_failed", user: "U5371", txn: "T70602", code: "E42" }, { event: "payment_retry_ok", txn: "T70602" }] },
  { user: "U5490", expected: true, events: [{ event: "payment_failed", user: "U5490", txn: "T70788", code: "E42" }, { event: "payment_retry_ok", txn: "T70788" }] },
  { user: "U5562", expected: true, events: [{ event: "payment_failed", user: "U5562", txn: "T70815", code: "E42" }, { event: "payment_retry_ok", txn: "T70815" }] },
  // Succeeds only on the second retry.
  {
    user: "U5647",
    expected: true,
    events: [
      { event: "payment_failed", user: "U5647", txn: "T70937", code: "E42" },
      { event: "payment_retry_failed", txn: "T70937", code: "E42" },
      { event: "payment_retry_ok", txn: "T70937" },
    ],
  },
  // Decoys.
  { user: "U5711", expected: false, events: [{ event: "payment_failed", user: "U5711", txn: "T71024", code: "E42" }] },
  { user: "U5726", expected: false, events: [{ event: "payment_failed", user: "U5726", txn: "T71077", code: "E42" }] },
  { user: "U5803", expected: false, events: [{ event: "payment_failed", user: "U5803", txn: "T71135", code: "E42" }, { event: "payment_retry_failed", txn: "T71135", code: "E42" }] },
  { user: "U5819", expected: false, events: [{ event: "payment_failed", user: "U5819", txn: "T71190", code: "E42" }, { event: "payment_retry_failed", txn: "T71190", code: "E42" }] },
  { user: "U5904", expected: false, events: [{ event: "refund_failed", user: "U5904", txn: "R80213", code: "E42" }, { event: "refund_retry_ok", txn: "R80213" }] },
  { user: "U5926", expected: false, events: [{ event: "refund_failed", user: "U5926", txn: "R80266", code: "E42" }, { event: "refund_retry_ok", txn: "R80266" }] },
  { user: "U6012", expected: false, events: [{ event: "payment_failed", user: "U6012", txn: "T71305", code: "E17" }, { event: "payment_retry_ok", txn: "T71305" }] },
  { user: "U6047", expected: false, events: [{ event: "payment_failed", user: "U6047", txn: "T71342", code: "E17" }, { event: "payment_retry_ok", txn: "T71342" }] },
  { user: "U6135", expected: false, events: [{ event: "payment_failed", user: "U6135", txn: "T71420", code: "E420" }, { event: "payment_retry_ok", txn: "T71420" }] },
  // E42 on one transaction (never retried), E17 on another (retried successfully).
  {
    user: "U6208",
    expected: false,
    events: [
      { event: "payment_failed", user: "U6208", txn: "T71501", code: "E42" },
      { event: "payment_failed", user: "U6208", txn: "T71566", code: "E17" },
      { event: "payment_retry_ok", txn: "T71566" },
    ],
  },
];

export const EXPECTED_USERS = STORIES.filter((s) => s.expected).map((s) => s.user);
export const DECOY_USERS = STORIES.filter((s) => !s.expected).map((s) => s.user);

const NOISE = ["page_view path=/cart", "page_view path=/search", "cart_add sku=", "login method=password", "logout", "search q=", "payment_ok txn=T6"];

export function buildLog(): string {
  const rand = prng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const lines: string[] = [];
  for (let i = 0; i < NOISE_LINES; i++) {
    const user = `U${1000 + Math.floor(rand() * 4000)}`; // never one of the story users (U5000+)
    let what = pick(NOISE);
    if (what.endsWith("=")) what += Math.floor(rand() * 90000 + 10000);
    else if (what === "payment_ok txn=T6") what += Math.floor(rand() * 9000 + 1000);
    const [name, ...rest] = what.split(" ");
    const fields = [`event=${name}`, `user=${user}`, ...rest].join(" ");
    lines.push(`svc=${name!.startsWith("payment") ? "payments" : "web"} ${fields} latency_ms=${Math.floor(rand() * 400 + 20)}`);
  }
  // Spread every story's events over the log, in order, with gaps between them.
  STORIES.forEach((story, s) => {
    let at = Math.floor(((s + 0.5) / STORIES.length) * NOISE_LINES * 0.6);
    for (const e of story.events) {
      const fields = [`event=${e.event}`, e.user && `user=${e.user}`, `txn=${e.txn}`, e.code && `code=${e.code}`].filter(Boolean).join(" ");
      const svc = e.event.startsWith("refund") ? "refunds" : "payments";
      lines.splice(at, 0, `svc=${svc} ${fields} latency_ms=${Math.floor(rand() * 400 + 20)}`);
      at += 150 + Math.floor(rand() * 300);
    }
  });
  const start = Date.UTC(2026, 2, 2, 8, 0, 0);
  return lines.map((l, i) => `${new Date(start + i * 1_370).toISOString()} ${l}`).join("\n") + "\n";
}

/** Paragraphs of an answer, with consecutive list items kept together even when blank lines separate them. */
function answerBlocks(text: string): string[] {
  const isItem = (p: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(p);
  const blocks: string[] = [];
  let prevItem = false;
  for (const p of text.split(/\n\s*\n/)) {
    if (isItem(p) && prevItem) blocks[blocks.length - 1] += `\n${p}`;
    else blocks.push(p);
    prevItem = isItem(p);
  }
  return blocks;
}

export const task: EvalTask = {
  id: "log-needle",
  description: "Hard: join E42 payment failures with later successful retries in a log twice the context window",
  prompt:
    "logs/app.log is the payment service's log. Which users had a payment fail with error code E42 and then succeed " +
    "when that payment was retried? List only those user IDs.",
  suite: "hard",
  maxSteps: 40,
  setup(dir) {
    write(dir, "logs/app.log", buildLog());
  },
  check(_dir, result) {
    // Models often name the excluded users too: in a table of every E42 failure before the answer,
    // or in a note after it. A block (a paragraph, or a list even with blank lines between its
    // items) naming exactly the right users is the answer; otherwise the last block naming users is.
    const ids = (s: string) => new Set(s.match(/\bU\d{4}\b/g) ?? []);
    const blocks = answerBlocks(result.finalText ?? "").filter((b) => ids(b).size > 0);
    const exact = blocks.find((b) => { const s = ids(b); return s.size === EXPECTED_USERS.length && EXPECTED_USERS.every((u) => s.has(u)); });
    const mentioned = ids(exact ?? blocks.at(-1) ?? "");
    const missing = EXPECTED_USERS.filter((u) => !mentioned.has(u));
    const decoys = DECOY_USERS.filter((u) => mentioned.has(u));
    const problems = [missing.length && `missing: ${missing.join(", ")}`, decoys.length && `wrongly included: ${decoys.join(", ")}`].filter(Boolean);
    const details = { found: EXPECTED_USERS.length - missing.length, of: EXPECTED_USERS.length, decoys };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
