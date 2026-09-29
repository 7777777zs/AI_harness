// Session-level knowledge of the project's files, computed by the harness (not the model):
// "known files" come from listing-type tool results, "read" from successful read_file calls.
// Rendered into a status block that is attached to every model call and therefore never
// elided or summarized, so the file list and the unread files can't be lost to compaction.
import fs from "node:fs";
import path from "node:path";
import { compressListing, isListing, parseListing } from "./listing.js";
import { estimateChars } from "./tokens.js";

/** Directories whose contents never count as project files. */
export const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
/** Above this size (estimated tokens) the status block lists directories with file counts. */
export const STATUS_MAX_TOKENS = 1_500;
export const STATUS_PREFIX = "[Harness status — not a new instruction]";

/** Does the task plausibly concern the whole project (so unread files matter)? */
export function isWholeProjectTask(task: string): boolean {
  return /\b(?:each|every|all)\b[^.?!]{0,40}\b(?:files?|modules?|sources?|components?)\b|\b(?:project|codebase|code base|repo|repository)\b/i.test(
    task,
  );
}

/** Directory argument of a listing command, e.g. `dir /b app` -> "app" (output may be relative to it). */
function listingBase(toolName: string, args: Record<string, unknown> | null | undefined): string {
  if (toolName !== "run_shell" || typeof args?.command !== "string") return "";
  const m = /^\s*(?:dir|ls|gci|get-childitem|tree|find)\s+(.*)$/i.exec(args.command.split(/&&|\||;/)[0]!);
  if (!m) return "";
  for (const raw of m[1]!.split(/\s+/)) {
    const tok = raw.replace(/^["']|["']$/g, "");
    if (!tok || tok.startsWith("-") || /^\/\w{1,2}$/.test(tok) || /[*?]/.test(tok) || tok === ".") continue;
    return tok.replace(/\\/g, "/").replace(/\/$/, "");
  }
  return "";
}

export class Coverage {
  /** Known project files, relative to cwd with forward slashes. */
  readonly known = new Set<string>();
  /** Files read with read_file; "partial" when only a line range was read. */
  readonly read = new Map<string, "full" | "partial">();

  constructor(private readonly cwd: string) {}

  /** Normalize a tool path argument to a cwd-relative, forward-slash path (null if outside cwd). */
  relative(p: string): string | null {
    const abs = path.resolve(this.cwd, p.replace(/\\/g, "/"));
    const rel = path.relative(this.cwd, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private isIgnored(rel: string): boolean {
    return rel.split("/").some((part) => IGNORED_DIRS.has(part));
  }

  private isFile(rel: string): boolean {
    return fs.statSync(path.join(this.cwd, rel), { throwIfNoEntry: false })?.isFile() ?? false;
  }

  /**
   * Record the files from a listing-type tool result (full, untruncated output). Only paths
   * that exist as files under cwd are kept, which also resolves listings of a subdirectory.
   * Returns how many new files became known.
   */
  addListing(toolName: string, args: Record<string, unknown> | null | undefined, output: string): number {
    if (!isListing(toolName, args, output)) return 0;
    const base = listingBase(toolName, args);
    let added = 0;
    for (const p of parseListing(output)) {
      if (p.endsWith("/")) continue;
      for (const candidate of base ? [p, `${base}/${p}`] : [p]) {
        const rel = this.relative(candidate);
        if (!rel || this.isIgnored(rel) || !this.isFile(rel)) continue;
        if (!this.known.has(rel)) {
          this.known.add(rel);
          added++;
        }
        break;
      }
    }
    return added;
  }

  /** Record a successful read_file. A partial (offset/limit) read never downgrades a full one. */
  markRead(p: string, partial = false): void {
    const rel = this.relative(p);
    if (!rel) return;
    if (partial && this.read.get(rel) === "full") return;
    this.read.set(rel, partial ? "partial" : "full");
  }

  unread(): string[] {
    return [...this.known].filter((f) => !this.read.has(f)).sort();
  }

  /** Grouped listing of `files`; if too large, directories with counts plus full paths for `relevantDirs`. */
  private render(files: string[], relevantDirs: Set<string>, maxChars: number): string {
    const full = compressListing(files, Infinity);
    if (full.length <= maxChars) return full;
    const byDir = new Map<string, string[]>();
    for (const f of files) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "./";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    const parts: string[] = [];
    for (const [dir, list] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(relevantDirs.has(dir) ? compressListing(list, Infinity) : `${dir} (${list.length} file${list.length === 1 ? "" : "s"})`);
    }
    return parts.join("; ");
  }

  /** Directories named in the task, or containing a file already read. */
  private relevantDirs(task: string): Set<string> {
    const dirs = new Set<string>();
    const lower = task.toLowerCase();
    for (const f of this.known) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "./";
      const name = dir.replace(/\/$/, "").split("/").pop()!;
      if (this.read.has(f) || (name && name !== "." && lower.includes(name.toLowerCase()))) dirs.add(dir);
    }
    return dirs;
  }

  /** The pinned status block, or null when no listing has been seen yet. */
  statusBlock(task: string, maxTokens = STATUS_MAX_TOKENS): string | null {
    if (this.known.size === 0) return null;
    const known = [...this.known].sort();
    const unread = this.unread();
    const readCount = known.length - unread.length;
    const partial = known.filter((f) => this.read.get(f) === "partial").length;
    const build = (maxChars: number) => {
      const relevant = this.relevantDirs(task);
      const lines = [
        STATUS_PREFIX,
        `Known project files (${known.length}), from your listings: ${this.render(known, relevant, maxChars)}`,
        `Read: ${readCount}${partial ? ` (${partial} partially)` : ""} / Not yet read: ${unread.length}`,
      ];
      if (unread.length) lines.push(`Not yet read: ${this.render(unread, relevant, maxChars)}`);
      return lines.join("\n");
    };
    let text = build(Infinity);
    if (estimateChars(text.length) > maxTokens) text = build(Math.floor((maxTokens * 4) / 3));
    return text;
  }

  /**
   * Deterministic coverage footer for the final answer, or null when every known file was read
   * in full. Directories with 3+ unread files are summarized as "dir/ (N files)".
   */
  footer(): string | null {
    if (this.known.size === 0) return null;
    const unread = this.unread();
    const partial = [...this.known].filter((f) => this.read.get(f) === "partial").sort();
    if (unread.length === 0 && partial.length === 0) return null;
    const readCount = this.known.size - unread.length;

    const byDir = new Map<string, string[]>();
    for (const f of unread) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    const items: string[] = [];
    for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
      if (dir && files.length >= 3) items.push(`${dir} (${files.length} files)`);
      else items.push(...files);
    }
    const MAX_ITEMS = 40;
    const shown = items.slice(0, MAX_ITEMS).join(", ") + (items.length > MAX_ITEMS ? `, … (+${items.length - MAX_ITEMS} more)` : "");

    let text = `--- Coverage (reported by harness): read ${readCount} of ${this.known.size} known files`;
    if (partial.length) text += ` (${partial.length} only partially)`;
    text += ".";
    if (unread.length) text += ` Not read: ${shown}.`;
    if (partial.length) text += ` Partially read (line ranges only): ${partial.join(", ")}.`;
    return text;
  }

  /** Compact unread list for messages (e.g. the coverage check). */
  unreadText(maxChars = 3_000): string {
    return compressListing(this.unread(), maxChars);
  }
}
