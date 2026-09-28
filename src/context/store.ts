// In-memory state that must survive across compactions within one agent run.

export interface OriginalResult {
  name: string;
  args: Record<string, unknown> | null;
  /** The tool result exactly as the model first saw it (after truncation). */
  content: string;
}

export class ContextStore {
  /** Original tool-result content by tool call id, so Level 2 can summarize real content. */
  readonly originals = new Map<string, OriginalResult>();
  /** Level 1 descriptions by tool call id, so each result is described at most once. */
  readonly descriptions = new Map<string, string>();

  record(toolCallId: string, name: string, args: Record<string, unknown> | null, content: string): void {
    this.originals.set(toolCallId, { name, args, content });
  }

  /** Short argument label for placeholders, e.g. the file path or the start of a shell command. */
  label(toolCallId: string): string {
    const args = this.originals.get(toolCallId)?.args;
    if (!args) return "";
    const value = typeof args.path === "string" ? args.path : typeof args.command === "string" ? args.command : "";
    return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
}
