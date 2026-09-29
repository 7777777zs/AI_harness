// Oversized results from untrusted (MCP) tools are paginated instead of head+tail truncated:
// the model sees the first page, and the full text stays in memory (never on disk) so the
// read_tool_result tool can return any later page. Every page stays within the result cap.
import type { Tool } from "../types.js";
import { READ_TOOL_RESULT } from "./names.js";

/** Characters per page at most; the per-result token cap can make pages smaller. */
export const PAGE_CHARS = 10_000;

export interface PageLimits {
  maxChars: number;
  maxTokens: number;
  tokensOf: (text: string) => number;
}

export class ResultPages {
  private readonly results = new Map<string, string>();
  private next = 1;

  /** The content if it fits in one page; otherwise its first page plus a continuation note. */
  paginate(content: string, limits: PageLimits): string {
    const first = pageEnd(content, 0, limits.maxChars, limits);
    if (first >= content.length) return content;
    const id = `mcp-${this.next++}`;
    this.results.set(id, content);
    return render(id, content, 0, first);
  }

  /** The built-in read_tool_result tool over this run's stored results. */
  tool(limits: () => PageLimits): Tool {
    return {
      name: READ_TOOL_RESULT,
      description:
        "Read more of a long result from an MCP tool that was cut into pages. Use the id and offset " +
        "given in the note at the end of the page; returns up to one page of characters. With `pattern`, " +
        "instead lists the lines containing that text (case-insensitive) with their offsets.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: 'Result id from the note, e.g. "mcp-1"' },
          offset: { type: "integer", description: "0-based character offset to start from (from the note or a search)" },
          limit: { type: "integer", description: `Characters to return (at most ${PAGE_CHARS})` },
          pattern: { type: "string", description: "Text to search for in the whole stored result" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = String(args.id ?? "");
        const content = this.results.get(id);
        if (content === undefined) {
          const known = [...this.results.keys()];
          return `Error: No stored result with id "${id}"${known.length ? ` (stored: ${known.join(", ")})` : ""}`;
        }
        if (typeof args.pattern === "string" && args.pattern.trim()) return search(id, content, args.pattern.trim());
        const offset = Number(args.offset ?? 0);
        if (!Number.isInteger(offset) || offset < 0 || offset >= content.length) {
          return `Error: offset must be an integer from 0 to ${content.length - 1}`;
        }
        const l = limits();
        const requested = args.limit === undefined ? l.maxChars : Number(args.limit);
        if (!Number.isInteger(requested) || requested < 1) return "Error: limit must be a positive integer";
        const end = pageEnd(content, offset, Math.min(requested, l.maxChars), l);
        return render(id, content, offset, end);
      },
    };
  }
}

/** End of a page starting at `offset`: within maxChars and maxTokens, at a line break if possible. */
function pageEnd(content: string, offset: number, maxChars: number, limits: PageLimits): number {
  let end = Math.min(content.length, offset + maxChars);
  // Leave room for the continuation note.
  while (end > offset + 1 && limits.tokensOf(content.slice(offset, end)) > limits.maxTokens - 60) {
    end = offset + Math.floor((end - offset) * 0.8);
  }
  if (end < content.length) {
    const lineBreak = content.lastIndexOf("\n", end);
    if (lineBreak > offset + (end - offset) / 2) end = lineBreak + 1;
  }
  return Math.max(end, offset + 1);
}

const MAX_MATCHES = 20;
const MAX_MATCH_LINE = 300;

/** Lines of the stored result containing `pattern` (case-insensitive), with their start offsets. */
function search(id: string, content: string, pattern: string): string {
  const needle = pattern.toLowerCase();
  const hits: string[] = [];
  let total = 0;
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf("\n", start);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(start, end);
    if (line.toLowerCase().includes(needle)) {
      total++;
      if (hits.length < MAX_MATCHES) {
        const shown = line.length > MAX_MATCH_LINE ? `${line.slice(0, MAX_MATCH_LINE)}…` : line;
        hits.push(`offset ${start}: ${shown.trim()}`);
      }
    }
    start = end + 1;
  }
  if (total === 0) return `No lines in stored result ${id} contain "${pattern}".`;
  return (
    `${total} line(s) in stored result ${id} contain "${pattern}"${total > hits.length ? ` (first ${hits.length} shown)` : ""}:\n` +
    `${hits.join("\n")}\n[Use ${READ_TOOL_RESULT} with id="${id}" and an offset to read the text around a match.]`
  );
}

function render(id: string, content: string, offset: number, end: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const body = content.slice(offset, end).replace(/\n$/, "");
  if (end >= content.length) {
    return `${body}\n[End of stored result ${id}: chars ${n(offset + 1)}–${n(end)} of ${n(content.length)}.]`;
  }
  return (
    `${body}\n[Showing chars ${n(offset + 1)}–${n(end)} of ${n(content.length)}. ` +
    `Use ${READ_TOOL_RESULT} with id="${id}" and offset=${end} to read more, or with pattern to search it.]`
  );
}
