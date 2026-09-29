// Detection and compression of file-listing tool results. When a listing has to be
// elided, the paths themselves are kept (grouped per directory) instead of a model
// description, because an agent that loses the file list starts guessing paths.
import { isUntrustedToolName } from "../mcp/names.js";

const LISTING_COMMAND = /^\s*(?:git\s+ls-files|ls|dir|find|tree|get-childitem|gci|fd)\b/i;
/** Tree-drawing characters used by `tree` (unix and Windows). */
const TREE_GLYPHS = /^[\s│├└─|`+\\-]*/;
const DIR_LINE =
  /^\s*\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s+(<DIR>|<JUNCTION>|[\d,.]+)\s+(.+?)\s*$/i;
export const LISTING_MAX_CHARS = 3_000;

/**
 * run_shell results are wrapped as "exit code: N\nstdout:\n<out>\nstderr:\n<err>"; a listing
 * lives in stdout. Without unwrapping, "stdout:" looks like an `ls -R` directory header and
 * every path would get a bogus "stdout/" prefix. Other content is returned unchanged.
 */
export function shellStdout(content: string): string {
  const m = /^(?:exit code: -?\d+|killed: [^\n]*|error: [^\n]*)\r?\nstdout:\r?\n([\s\S]*?)\r?\nstderr:\r?\n[\s\S]*$/.exec(content);
  return m ? m[1]! : content;
}

/** A line that is plausibly a single file or directory path. */
function isPathLike(line: string): boolean {
  const t = line.replace(TREE_GLYPHS, "").trim();
  if (!t || /\s{2,}/.test(t) || t.length > 260) return false;
  return /[\/\\]/.test(t) || /^[\w.@-]+\.[A-Za-z0-9]{1,8}$/.test(t) || /^[\w.@-]+\/?$/.test(t);
}

/** Tools whose output is always a file listing (cwd-relative paths, "/" for directories). */
const LISTING_TOOLS = new Set(["list_dir", "glob"]);
/** list_dir size / link suffix, e.g. "src/app.ts (4.1 KB)" or "linked/ (link, not followed)". */
const LIST_DIR_SUFFIX = / \((?:\d+ B|\d+(?:\.\d+)? [KM]B|link, not followed)\)$/;
/** Notes that are not paths: list_dir/glob footers, "(empty directory)", truncation markers. */
const NOTE_LINE = /^(?:\[|\(empty directory\)|No files match\b)/;

export function isListing(toolName: string, args: Record<string, unknown> | null | undefined, content: string): boolean {
  // Untrusted results (e.g. web pages from an MCP server) never name project files.
  if (isUntrustedToolName(toolName)) return false;
  if (LISTING_TOOLS.has(toolName)) return true;
  if (toolName === "run_shell" && typeof args?.command === "string" && LISTING_COMMAND.test(args.command)) return true;
  const lines = shellStdout(content).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 5) return false;
  return lines.filter(isPathLike).length / lines.length >= 0.7;
}

/** Extract relative paths from the common listing formats; directories end with "/". */
export function parseListing(content: string): string[] {
  const paths: string[] = [];
  const treeStack: string[] = [];
  let currentDir = ""; // from `dir` "Directory of X" or `ls -R` "X:" headers
  let sawTree = false;

  for (const raw of shellStdout(content).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "").replace(LIST_DIR_SUFFIX, "");
    if (!line.trim() || NOTE_LINE.test(line.trim())) continue;

    const dirOf = /^\s*Directory of\s+(.+)$/i.exec(line);
    if (dirOf) {
      currentDir = dirOf[1]!.trim();
      continue;
    }
    if (/^\s*(Volume in drive|Volume Serial Number|Folder PATH listing|\d+\s+File\(s\)|\d+\s+Dir\(s\)|Total Files Listed|\d+ director(y|ies))/i.test(line)) continue;
    if (/^\s*(?:\.{1,2}|[A-Za-z]:\.?)\s*$/.test(line)) continue; // "." / ".." / tree root "C:."
    const lsHeader = /^([^\s].*):$/.exec(line);
    if (lsHeader && !/^[A-Za-z]:$/.test(lsHeader[1]!)) {
      currentDir = lsHeader[1]!;
      continue;
    }

    const dirLine = DIR_LINE.exec(line);
    if (dirLine) {
      const name = dirLine[2]!;
      if (name === "." || name === "..") continue;
      const isDir = /^<(DIR|JUNCTION)>$/i.test(dirLine[1]!);
      paths.push(join(currentDir, name) + (isDir ? "/" : ""));
      continue;
    }

    const glyphs = TREE_GLYPHS.exec(line)![0];
    const name = line.slice(glyphs.length).trim();
    if (/[│├└]|── |\|-- |`-- /.test(glyphs)) {
      // `tree` output: nesting depth from the glyph prefix (4 columns per level).
      sawTree = true;
      const level = Math.max(0, Math.round(glyphs.replace(/\t/g, "    ").length / 4) - 1);
      treeStack.length = level;
      treeStack.push(name);
      paths.push(treeStack.join("/"));
      continue;
    }
    if (sawTree && treeStack.length === 0 && paths.length === 0) continue; // tree root line
    if (!isPathLike(line)) continue;
    paths.push(join(currentDir, name));
  }
  return relativize(paths);
}

function join(dir: string, name: string): string {
  return dir ? `${dir.replace(/[\/\\]+$/, "")}/${name}` : name;
}

/** Normalize separators and strip the longest common absolute directory prefix. */
function relativize(paths: string[]): string[] {
  const norm = paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  const absolute = norm.filter((p) => /^(?:[A-Za-z]:)?\//.test(p));
  if (absolute.length === 0) return dedupe(norm);
  let prefix = absolute[0]!.split("/").slice(0, -1);
  for (const p of absolute) {
    const parts = p.split("/");
    let i = 0;
    while (i < prefix.length && i < parts.length - 1 && prefix[i]!.toLowerCase() === parts[i]!.toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  const strip = prefix.join("/") + "/";
  return dedupe(norm.map((p) => (p.toLowerCase().startsWith(strip.toLowerCase()) ? p.slice(strip.length) : p)).filter(Boolean));
}

/** Remove duplicates and mark entries that have children as directories ("app" -> "app/"). */
function dedupe(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  const parents = new Set<string>();
  for (const p of unique) {
    const parts = p.replace(/\/$/, "").split("/");
    for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
  }
  return [...new Set(unique.map((p) => (!p.endsWith("/") && parents.has(p) ? `${p}/` : p)))];
}

/**
 * Group paths per directory: "app/: agent.py, db.py; tests/: test_agent.py".
 * Truncates only above `maxChars`, saying how many paths were omitted.
 */
export function compressListing(paths: string[], maxChars = LISTING_MAX_CHARS): string {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
    const slash = trimmed.lastIndexOf("/");
    const dir = slash === -1 ? "./" : trimmed.slice(0, slash + 1);
    const name = trimmed.slice(slash + 1) + (p.endsWith("/") ? "/" : "");
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(name);
  }
  const entries = [...groups.entries()].sort(([a], [b]) => (a === "./" ? -1 : b === "./" ? 1 : a.localeCompare(b)));
  let out = "";
  let shown = 0;
  for (const [dir, names] of entries) {
    const line = `${dir}: ${names.join(", ")}`;
    if (out && out.length + line.length + 2 > maxChars) break;
    out += (out ? "; " : "") + line;
    shown += names.length;
  }
  const omitted = paths.length - shown;
  return omitted > 0 ? `${out} (+${omitted} more paths omitted)` : out;
}
