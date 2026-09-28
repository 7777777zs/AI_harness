import type { LLMClient, Message, Usage } from "../llm/types.js";
import type { Describer, DescribeItem, Summarizer } from "./compact.js";

/**
 * Per-item limit for text sent to the describer and the Level 2 summarizer. Content up to
 * this size is sent in full; only longer content gets a head+tail cut. (A head/tail-only
 * view of a 6k-char file used to hide its middle, where the actual definitions often are.)
 */
export const DESCRIBE_MAX_CHARS = 12_000;
/** Maximum characters of item content per describer call; larger batches are split. */
export const DESCRIBE_BATCH_CHARS = 48_000;
const MAX_DESCRIPTION_CHARS = 300;

const SYSTEM_PROMPT =
  "You compress the history of an AI coding agent's session so it can continue with less context. " +
  "Write these sections, in this order:\n" +
  "1. Assistant notes: the assistant's own findings and notes from its replies, kept as close to verbatim as " +
  "the space allows. These matter more than tool output; shorten tool output first.\n" +
  "2. Files touched: paths and what was done with them.\n" +
  "3. Key findings from tool output that the agent will still need (facts, values, results).\n" +
  "4. Remaining work: what is still left to do for the task. Do not list unread files here; the harness adds that list.\n" +
  "Never state that the task is complete, that nothing remains, or that no issues remain: the agent decides that later. " +
  "Keep exact file names, identifiers, numbers and codes. Do not invent anything; only mention names " +
  "that appear verbatim in the conversation.";

/** Keep text up to `max` chars in full; above that keep head and tail with a marker. */
export function fitForModel(s: string, max = DESCRIBE_MAX_CHARS): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n[… ${s.length - max} chars omitted …]\n${s.slice(-tail)}`;
}

/** Render messages as plain text so the summary request carries no tool-call structure. */
export function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      switch (m.role) {
        case "system":
          return `SYSTEM: ${fitForModel(m.content)}`;
        case "user":
          return `USER: ${fitForModel(m.content)}`;
        case "assistant": {
          const calls = m.toolCalls.map((c) => `  -> called ${c.name}(${fitForModel(JSON.stringify(c.args ?? {}))})`);
          return [`ASSISTANT: ${m.content ?? ""}`, ...calls].join("\n");
        }
        case "tool":
          return `TOOL RESULT (${m.name}): ${fitForModel(m.content)}`;
      }
    })
    .join("\n\n");
}

/** A Summarizer backed by an LLM call with no tools. Reports token usage via `onUsage`. */
export function makeSummarizer(client: LLMClient, onUsage: (u: Usage) => void): Summarizer {
  return async (older, task) => {
    const response = await client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Original task:\n${task}\n\nConversation to summarize:\n\n${renderTranscript(older)}`,
        },
      ],
      [],
    );
    onUsage(response.usage);
    if (!response.text?.trim()) throw new Error("summarizer returned an empty response");
    return response.text.trim();
  };
}

const DESCRIBE_PROMPT =
  "You label tool results from an AI coding agent's session so they can be removed from its context. " +
  "For each item, write one or two plain sentences saying what it is for (for a source file: its purpose; " +
  "for command output: what it shows). " +
  "Only mention names (functions, methods, classes, variables, files) that appear verbatim in that item's text. " +
  "If you are unsure about a name, describe the purpose without naming anything. Never guess. " +
  'Reply with only a JSON object mapping each item id to its description, e.g. {"call_1": "…"}.';

/** Parse a JSON object of id -> description from a model reply, tolerating surrounding text. */
export function parseDescriptions(text: string): Record<string, string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("describer reply contains no JSON object");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("describer reply is not a JSON object");
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const flat = value.replace(/\s+/g, " ").trim();
    out[id] = flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS)}…` : flat;
  }
  return out;
}

/** Split items into batches whose (fitted) content stays under `maxChars` each. */
export function batchItems(items: DescribeItem[], maxChars = DESCRIBE_BATCH_CHARS): DescribeItem[][] {
  const batches: DescribeItem[][] = [];
  let current: DescribeItem[] = [];
  let size = 0;
  for (const it of items) {
    const len = fitForModel(it.content).length;
    if (current.length && size + len > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(it);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * A Describer that labels items with as few LLM calls as possible: one call per batch,
 * batches split only when the content would exceed DESCRIBE_BATCH_CHARS. A failed batch
 * leaves its items undescribed; if every batch fails, the first error is thrown.
 */
export function makeDescriber(client: LLMClient, onUsage: (u: Usage) => void): Describer {
  return async (items: DescribeItem[]) => {
    const out: Record<string, string> = {};
    const errors: unknown[] = [];
    const batches = batchItems(items);
    for (const batch of batches) {
      const body = batch
        .map((it) => `### id: ${it.id}\ntool: ${it.tool}${it.label ? ` (${it.label})` : ""}\n${fitForModel(it.content)}`)
        .join("\n\n");
      try {
        const response = await client.chat(
          [
            { role: "system", content: DESCRIBE_PROMPT },
            { role: "user", content: body },
          ],
          [],
        );
        onUsage(response.usage);
        Object.assign(out, parseDescriptions(response.text ?? ""));
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length && errors.length === batches.length) throw errors[0];
    return out;
  };
}
