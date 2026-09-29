import type { Message } from "../llm/types.js";
import { compressListing, isListing, parseListing } from "./listing.js";
import { ContextStore } from "./store.js";
import { extractSymbols, formatSymbols } from "./symbols.js";
import { estimateChars, estimateTokens } from "./tokens.js";
import { splitTurns, validatePairing } from "./turns.js";

/** Level 2 keeps the most recent turn groups intact. */
export const KEEP_TURNS = 3;
/** Default share of the context limit reserved for recent tool results kept in full. */
export const RECENT_BUDGET_FRACTION = 0.4;
/** Level 2 is not worth a summarizer call below this span size (estimated tokens). */
export const L2_MIN_SPAN_TOKENS = 1_000;
/** A Level 2 summary must save at least this fraction of the span it replaces. */
export const L2_MIN_SAVING = 0.2;
/**
 * Tool results this short are never elided. Short outputs (small listings, error messages,
 * config files) are cheap to keep and costly to lose: agents that lose them start guessing.
 */
export const MIN_ELIDE_CHARS = 1_500;
const LOSSY_FILE = "This is a lossy summary — re-read the file if you need exact code, names, or details.";
const LOSSY_OUTPUT = "This is a lossy summary — re-run the command if you need the exact output.";

export const ELIDED_PREFIX = "[Elided:";
export const SUMMARY_PREFIX = "[Summary of earlier conversation, generated to save context]";

/** Summarizes older messages; receives the original task for context. */
export type Summarizer = (older: Message[], task: string) => Promise<string>;

export interface DescribeItem {
  id: string;
  tool: string;
  label: string;
  content: string;
}
/** Describes several tool results in one call; returns id -> one-to-two-sentence description. */
export type Describer = (items: DescribeItem[]) => Promise<Record<string, string>>;

export interface CompactionEvent {
  level: 1 | 2;
  beforeTokens: number;
  afterTokens: number;
  detail: string;
  summary?: string;
}

export interface Level2Outcome {
  status: "not_needed" | "accepted" | "rejected" | "skipped";
  /** Estimated tokens of the span Level 2 would replace (as currently in context). */
  spanTokens?: number;
  summaryTokens?: number;
  reason?: string;
}

export interface CompactOptions {
  /** Current estimated context size in tokens. */
  currentTokens: number;
  limit: number;
  threshold: number;
  /** Tokens of recent tool results kept in full. Defaults to RECENT_BUDGET_FRACTION × limit. */
  recentBudget?: number;
  summarize?: Summarizer;
  describe?: Describer;
  /** Originals and cached descriptions; persists across compactions within one run. */
  store?: ContextStore;
  /** Compact regardless of the threshold (after a context-length error). */
  force?: boolean;
  keepTurns?: number;
  /** Harness-computed remaining work (e.g. unread files), appended to Level 2 summaries. */
  remainingWork?: () => string;
  /** Calibration ratio (actual / heuristic tokens) applied to this function's own estimates. */
  tokenScale?: number;
}

export interface CompactResult {
  messages: Message[];
  /** Estimated tokens after compaction. */
  tokens: number;
  /** One event per level that changed something. */
  events: CompactionEvent[];
  level2: Level2Outcome;
  /** Set when the describer call failed and plain placeholders were used. */
  describeError?: string;
  /** Descriptions dropped because they named something not in the original. */
  rejectedDescriptions: { id: string; token: string; description: string }[];
  /** Other non-fatal remarks. */
  notes: string[];
}

/**
 * Pick the tool results Level 1 should elide. Walking backwards from the newest, results
 * are kept in full until they use `budgetTokens`; everything older than that is elided.
 * Results the model has not seen yet (after the last assistant message) are never elided,
 * and the newest result is always kept, even if it alone exceeds the budget.
 */
export function selectForElision(messages: Message[], budgetTokens: number): Set<number> {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });

  let used = 0;
  let keptAny = false;
  for (let i = messages.length - 1; i > lastAssistant; i--) {
    if (messages[i]!.role !== "tool") continue;
    used += estimateTokens([messages[i]!]);
    keptAny = true;
  }

  const elide = new Set<number>();
  let exhausted = false;
  for (let i = lastAssistant - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || m.content.startsWith(ELIDED_PREFIX)) continue;
    const tokens = estimateTokens([m]);
    if (!keptAny || (!exhausted && used + tokens <= budgetTokens)) {
      used += tokens;
      keptAny = true;
      continue;
    }
    exhausted = true;
    if (m.content.length > MIN_ELIDE_CHARS) elide.add(i);
  }
  return elide;
}

const FILE_EXT = /^(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|mts|cts|json|md|txt|toml|ya?ml|cfg|ini|html|css|sh|lock|csv|sql|rs|go|java|rb)$/i;

/**
 * Return the first identifier-like name in a model-written description that does not
 * appear verbatim in the original text (or the result's label), or null if all do.
 * Checked forms: `name(`, `obj.name`, and names inside backticks (file paths are skipped).
 */
export function unknownIdentifier(description: string, original: string, label = ""): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A plain name: must occur as a whole word anywhere in the original.
  const asWord = (n: string) => new RegExp(`(^|[^\\w$])${esc(n)}($|[^\\w$])`).test(original);
  // A name used as code (called, a member, a method): must be defined, called or assigned in
  // the original, so a string like "ui.chat.message" does not vouch for a `chat` method.
  const asCode = (n: string) =>
    new RegExp(`\\b(?:def|class|function|const|let|var)\\s+${esc(n)}\\b|${esc(n)}\\s*\\(|\\b${esc(n)}\\s*[:=](?!=)`).test(original);

  const checks: { name: string; ok: (n: string) => boolean }[] = [];
  for (const m of description.matchAll(/\b([A-Za-z_]\w*)\(/g)) checks.push({ name: m[1]!, ok: asCode });
  for (const m of description.matchAll(/\b[A-Za-z_]\w*\.([A-Za-z_]\w*)\b/g)) {
    if (!FILE_EXT.test(m[1]!)) checks.push({ name: m[1]!, ok: asCode });
  }
  for (const m of description.matchAll(/`([^`]+)`/g)) {
    const inner = m[1]!.replace(/\(\)$/, "");
    if (/[\/\\]|\.[A-Za-z0-9]{1,5}$/.test(inner) && FILE_EXT.test(inner.split(".").pop()!)) continue; // a file path
    const parts = inner.match(/[A-Za-z_]\w*/g) ?? [];
    parts.forEach((t, i) => checks.push({ name: t, ok: i > 0 && inner.includes(".") ? asCode : asWord }));
  }
  for (const { name, ok } of checks) {
    if (name.length < 2 || label.includes(name)) continue;
    if (!ok(name)) return name;
  }
  return null;
}

/**
 * read_file with offset/limit returns "<line no, width 6>\t<text>" lines plus an optional
 * "[lines A-B of T; ...]" footer. Strip both to get the source text (for symbol extraction).
 */
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .filter((l) => !/^\[lines \d+-\d+ of \d+/.test(l))
    .map((l) => l.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

interface PlaceholderParts {
  name: string;
  label: string;
  chars: number;
  symbols?: string;
  description?: string;
  /** Grouped paths for listing results, used instead of a description. */
  listing?: { text: string; count: number };
}

export function placeholder(p: PlaceholderParts): string {
  const head = `${ELIDED_PREFIX} ${p.label ? `${p.name} ${p.label}` : p.name} (${p.chars.toLocaleString("en-US")} chars).`;
  if (p.listing) return `${head} Paths (${p.listing.count}), grouped by directory: ${p.listing.text}]`;
  const parts = [head];
  if (p.symbols) parts.push(`Symbols: ${p.symbols}.`);
  if (p.description) parts.push(`Description: ${p.description.replace(/[.\s]+$/, "")}.`);
  parts.push(p.name === "run_shell" ? LOSSY_OUTPUT : LOSSY_FILE);
  return `${parts.join(" ")}]`;
}

/**
 * Level 1: replace old tool results (beyond the recent budget) with a short description.
 * All descriptions missing from the cache are generated in ONE describer call. Only
 * `content` changes: messages are never added, removed or reordered, so every tool call
 * keeps its matching result.
 */
export async function elideToolResults(
  messages: Message[],
  opts: { budgetTokens: number; store?: ContextStore; describe?: Describer },
) {
  const store = opts.store ?? new ContextStore();
  const targets = [...selectForElision(messages, opts.budgetTokens)].map((i) => {
    const m = messages[i] as Extract<Message, { role: "tool" }>;
    const original = store.originals.get(m.toolCallId)?.content ?? m.content;
    const args = store.originals.get(m.toolCallId)?.args;
    // Listings keep their paths (never a model description); code files get extracted symbols.
    const paths = isListing(m.name, args, original) ? parseListing(original) : [];
    const listing = paths.length ? { text: compressListing(paths), count: paths.length } : undefined;
    const ranged = args?.offset !== undefined || args?.limit !== undefined;
    const code = ranged ? stripLineNumbers(original) : original;
    const symbols = m.name === "read_file" && typeof args?.path === "string" ? extractSymbols(args.path, code) : null;
    const symbolText = symbols ? formatSymbols(symbols) : "";
    return { index: i, message: m, original, listing, symbols: symbolText };
  });

  let describeError: string | undefined;
  const rejected: { id: string; token: string; description: string }[] = [];
  const contentKey = (t: (typeof targets)[number]) =>
    store.contentKey(t.message.name, store.label(t.message.toolCallId), t.original);
  // Same tool, same label, same content as an earlier result: reuse its description.
  for (const t of targets) {
    const cached = store.descriptionsByContent.get(contentKey(t));
    if (!t.listing && cached !== undefined && !store.descriptions.has(t.message.toolCallId)) {
      store.descriptions.set(t.message.toolCallId, cached);
    }
  }
  const missing = targets.filter((t) => !t.listing && !store.descriptions.has(t.message.toolCallId));
  if (opts.describe && missing.length > 0) {
    try {
      const described = await opts.describe(
        missing.map((t) => ({
          id: t.message.toolCallId,
          tool: t.message.name,
          label: store.label(t.message.toolCallId),
          content: t.original,
        })),
      );
      for (const t of missing) {
        const id = t.message.toolCallId;
        const d = described[id];
        if (!d) continue;
        // Names in a description must exist in the original; otherwise drop the description.
        // Cached as "" so a rejected description is never regenerated.
        const token = unknownIdentifier(d, t.original, store.label(id));
        if (token) rejected.push({ id, token, description: d });
        store.descriptions.set(id, token ? "" : d);
        store.descriptionsByContent.set(contentKey(t), token ? "" : d);
      }
      const undescribed = missing.filter((t) => !store.descriptions.has(t.message.toolCallId)).length;
      if (undescribed > 0) describeError = `no description returned for ${undescribed} result(s)`;
    } catch (err) {
      describeError = err instanceof Error ? err.message : String(err);
    }
  }

  const out = [...messages];
  let savedChars = 0;
  let elided = 0;
  for (const t of targets) {
    const id = t.message.toolCallId;
    const text = placeholder({
      name: t.message.name,
      label: store.label(id),
      chars: t.message.content.length,
      ...(t.symbols && { symbols: t.symbols }),
      ...(store.descriptions.get(id) && { description: store.descriptions.get(id)! }),
      ...(t.listing && { listing: t.listing }),
    });
    if (text.length >= t.message.content.length) continue;
    savedChars += t.message.content.length - text.length;
    elided++;
    out[t.index] = { ...t.message, content: text };
  }
  return { messages: out, elided, savedTokens: estimateChars(savedChars), rejected, ...(describeError && { describeError }) };
}

/**
 * Level 2: replace everything between the pinned messages and the last `keepTurns` turn
 * groups with one summary message. The cut is at a turn-group boundary, so only complete
 * groups (assistant message + all its tool results) are removed. The summarizer sees the
 * ORIGINAL tool results from `store`, not Level 1 placeholders; results without a stored
 * original are passed as they are (their Level 1 description).
 * Returns null if there is no complete turn group old enough to summarize.
 */
export async function summarizeOlder(
  messages: Message[],
  summarize: Summarizer,
  keepTurns = KEEP_TURNS,
  store?: ContextStore,
  remainingWork?: () => string,
) {
  const { pinned, middle, recent } = splitTurns(messages, keepTurns);
  if (!middle.some((m) => m.role === "assistant")) return null;
  const input = middle.map((m): Message => (m.role === "tool" ? { ...m, content: level2Input(m, store) } : m));
  const raw = await summarize(input, pinned[1]?.content ?? "");
  const text = sanitizeSummary(raw, remainingWork?.());
  const summary: Message = { role: "user", content: `${SUMMARY_PREFIX}\n${text}` };
  return {
    messages: [...pinned, summary, ...recent],
    removed: middle.length,
    summary: text,
    spanTokens: estimateTokens(middle),
    summaryTokens: estimateTokens([summary]),
    inputTokens: estimateTokens(input),
  };
}

/**
 * What Level 2 sees for a tool result: a Level 1 placeholder that carries information
 * (symbols, a description, or paths) is passed as is, which keeps Level 2 input small.
 * Only results never described (not elided, or a plain placeholder) use the original.
 */
export function level2Input(m: Extract<Message, { role: "tool" }>, store?: ContextStore): string {
  if (m.content.startsWith(ELIDED_PREFIX)) {
    if (/\. (?:Symbols|Description): |\. Paths \(\d+\)/.test(m.content)) return m.content;
    return store?.originals.get(m.toolCallId)?.content ?? m.content;
  }
  return m.content;
}

/** Claims the summary must never make: the agent, not the summarizer, decides when work is done. */
const COMPLETION_CLAIM =
  /[^.\n]*\b(?:no (?:open |outstanding |remaining |further )?(?:issues?|work|tasks?|problems?) (?:remains?|left|outstanding)|nothing (?:else )?(?:remains|is left|left to do)|(?:the )?task (?:is|has been) (?:fully |now )?(?:complete|completed|finished|done)|all (?:files|work|tasks) (?:have|has) been (?:covered|read|reviewed|completed|done)|all (?:files|work) (?:are|is) (?:covered|done|complete))\b[^.\n]*(?:[.\n]|$)/gi;
const REMAINING_HEADING = /^[#*\s\d.)-]*remaining work\b[^\n]*$/im;
/** A line that is only one or more file paths (optionally a bullet): the harness owns those. */
const PATH_ONLY_LINE = /^\s*(?:[-*•]|\d+[.)])?\s*[`'"]?[\w.@-]*[\w@-][\/\\][\w.\/\\@-]*[`'"]?(?:\s*[,;]\s*[`'"]?[\w.\/\\@-]+[`'"]?)*\s*$|^\s*(?:[-*•]|\d+[.)])?\s*[`'"]?[\w@-]+\.[A-Za-z0-9]{1,8}[`'"]?(?:\s*[,;]\s*[`'"]?[\w.\/\\@-]+[`'"]?)*\s*$/;

/**
 * Enforce the Level 2 rules on a model-written summary: remove completion claims, drop
 * file-path lists the model wrote under "Remaining work", and append the harness-computed
 * unread-files list there instead.
 */
export function sanitizeSummary(text: string, harnessRemaining?: string): string {
  let out = text.replace(COMPLETION_CLAIM, "").replace(/\n{3,}/g, "\n\n").trim();
  const heading = REMAINING_HEADING.exec(out);
  if (heading) {
    const start = heading.index + heading[0].length;
    const kept = out
      .slice(start)
      .split("\n")
      .filter((line) => !PATH_ONLY_LINE.test(line))
      .join("\n")
      .trim();
    out = `${out.slice(0, start).trimEnd()}${kept ? `\n${kept}` : ""}`;
  } else {
    out += "\n\nRemaining work:";
  }
  if (harnessRemaining) out += `\n${harnessRemaining}`;
  return out;
}

/** Apply Level 1, then Level 2 if still needed. Pure except for the describer/summarizer calls. */
export async function compact(messages: Message[], opts: CompactOptions): Promise<CompactResult> {
  const keepTurns = opts.keepTurns ?? KEEP_TURNS;
  const scale = opts.tokenScale ?? 1;
  const budget = opts.limit * opts.threshold;
  const result: CompactResult = {
    messages,
    tokens: opts.currentTokens,
    events: [],
    level2: { status: "not_needed" },
    rejectedDescriptions: [],
    notes: [],
  };
  if (!opts.force && opts.currentTokens <= budget) return result;

  const l1 = await elideToolResults(messages, {
    budgetTokens: opts.recentBudget ?? opts.limit * RECENT_BUDGET_FRACTION,
    ...(opts.store && { store: opts.store }),
    ...(opts.describe && { describe: opts.describe }),
  });
  if (l1.describeError) result.describeError = l1.describeError;
  result.rejectedDescriptions = l1.rejected;
  if (l1.elided > 0) {
    const after = Math.max(0, result.tokens - Math.ceil(l1.savedTokens * scale));
    result.events.push({
      level: 1,
      beforeTokens: result.tokens,
      afterTokens: after,
      detail: `elided ${l1.elided} tool result${l1.elided === 1 ? "" : "s"}`,
    });
    result.messages = l1.messages;
    result.tokens = after;
  }

  if (!opts.force && result.tokens <= budget) return result;
  if (!opts.summarize) {
    result.notes.push("no summarizer available for Level 2");
    return result;
  }

  const { middle } = splitTurns(result.messages, keepTurns);
  if (!middle.some((m) => m.role === "assistant")) {
    result.notes.push(`nothing older than the last ${keepTurns} turns to summarize`);
    return result;
  }
  const spanTokens = Math.ceil(estimateTokens(middle) * scale);
  if (spanTokens < L2_MIN_SPAN_TOKENS) {
    result.level2 = { status: "skipped", spanTokens, reason: `span ~${spanTokens} tokens < ${L2_MIN_SPAN_TOKENS}` };
    return result;
  }

  let l2;
  try {
    l2 = await summarizeOlder(result.messages, opts.summarize, keepTurns, opts.store, opts.remainingWork);
  } catch (err) {
    result.notes.push(`Level 2 summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (!l2) return result;
  const pairingError = validatePairing(l2.messages);
  if (pairingError) {
    result.notes.push(`Level 2 discarded, it would break tool-call pairing: ${pairingError}`);
    return result;
  }
  const saved = Math.ceil((l2.spanTokens - l2.summaryTokens) * scale);
  if (saved < L2_MIN_SAVING * l2.spanTokens * scale) {
    result.level2 = {
      status: "rejected",
      spanTokens: l2.spanTokens,
      summaryTokens: l2.summaryTokens,
      reason: `summary saves ${saved} of ${l2.spanTokens} span tokens (< ${L2_MIN_SAVING * 100}%)`,
    };
    return result;
  }
  const after = result.tokens - saved;
  result.events.push({
    level: 2,
    beforeTokens: result.tokens,
    afterTokens: after,
    detail: `summarized ${l2.removed} message${l2.removed === 1 ? "" : "s"}`,
    summary: l2.summary,
  });
  result.level2 = { status: "accepted", spanTokens: l2.spanTokens, summaryTokens: l2.summaryTokens };
  result.messages = l2.messages;
  result.tokens = after;
  return result;
}
