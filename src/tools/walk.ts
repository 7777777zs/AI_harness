// Directory walker shared by list_dir, glob and grep. Implemented in Node (no `find`/`rg`), so it
// behaves the same on Windows, macOS and Linux.
//
// - Always skips the directories in DEFAULT_SKIP_DIRS, at any depth.
// - Honors .gitignore files in cwd, in the directories between cwd and the start directory, and
//   in every directory walked (each file's rules are relative to its own directory; later,
//   deeper files can re-include with "!"). Ignored directories are pruned, not filtered later.
// - If the start directory itself is ignored (e.g. the caller explicitly asked for
//   "node_modules/foo"), the ancestors' rules are dropped so that the request still works;
//   rules and the skip list still apply below it.
// - Never descends into symlinked directories or junctions (no cycles, no escaping cwd).
//   They are yielded with kind "link"; callers decide whether to show them.
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { toRel } from "./util.js";

export const DEFAULT_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
/** Maximum number of directory entries examined in one walk. */
export const WALK_BUDGET = 50_000;

export type EntryKind = "dir" | "file" | "link";

export interface WalkEntry {
  abs: string;
  /** Relative to cwd, forward slashes. */
  rel: string;
  /** Relative to the start directory, forward slashes. */
  relToStart: string;
  /** 1 = direct child of the start directory. */
  depth: number;
  kind: EntryKind;
  /** For kind "link": whether the link target is a directory. */
  linkIsDir?: boolean;
  /** For kind "file". */
  size?: number;
}

export interface WalkStats {
  visited: number;
  budgetHit: boolean;
  unreadableDirs: number;
}

export const newStats = (): WalkStats => ({ visited: 0, budgetHit: false, unreadableDirs: 0 });

type Ignore = ReturnType<typeof ignore>;

class IgnoreStack {
  private layers: { base: string; ig: Ignore }[] = [];

  /** Load `dirAbs/.gitignore` if it exists; returns true if a layer was pushed. */
  async load(cwd: string, dirAbs: string): Promise<boolean> {
    let text: string;
    try {
      text = await fs.readFile(path.join(dirAbs, ".gitignore"), "utf8");
    } catch {
      return false;
    }
    const base = toRel(cwd, dirAbs);
    this.layers.push({ base: base === "." ? "" : base, ig: ignore().add(text) });
    return true;
  }

  pop(): void {
    this.layers.pop();
  }

  clear(): void {
    this.layers = [];
  }

  ignored(rel: string, isDir: boolean): boolean {
    let state = false;
    for (const { base, ig } of this.layers) {
      if (base && !rel.startsWith(base + "/")) continue;
      const sub = base ? rel.slice(base.length + 1) : rel;
      const r = ig.test(isDir ? `${sub}/` : sub);
      if (r.ignored) state = true;
      else if (r.unignored) state = false;
    }
    return state;
  }
}

export function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Walk the directory `startAbs` (already checked with resolveInCwd), depth-first, sorted by name. */
export async function* walk(
  cwd: string,
  startAbs: string,
  { maxDepth = Infinity, stats = newStats(), budget = WALK_BUDGET }: { maxDepth?: number; stats?: WalkStats; budget?: number } = {},
): AsyncGenerator<WalkEntry> {
  const ign = new IgnoreStack();
  const relStart = path.relative(cwd, startAbs);
  const parts = relStart ? relStart.split(path.sep) : [];
  let dir = cwd;
  for (const part of parts) {
    await ign.load(cwd, dir);
    dir = path.join(dir, part);
  }
  if (parts.length && ign.ignored(toRel(cwd, startAbs), true)) ign.clear();

  async function* walkDir(dirAbs: string, depth: number): AsyncGenerator<WalkEntry> {
    const loaded = await ign.load(cwd, dirAbs);
    try {
      let dirents;
      try {
        dirents = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        stats.unreadableDirs++;
        return;
      }
      dirents.sort((a, b) => compareNames(a.name, b.name));
      for (const d of dirents) {
        if (stats.budgetHit) return;
        if (++stats.visited > budget) {
          stats.budgetHit = true;
          return;
        }
        const abs = path.join(dirAbs, d.name);
        let kind: EntryKind;
        let linkIsDir: boolean | undefined;
        if (d.isSymbolicLink()) {
          kind = "link";
          linkIsDir = await fs.stat(abs).then((s) => s.isDirectory(), () => false);
        } else if (d.isDirectory()) kind = "dir";
        else if (d.isFile()) kind = "file";
        else continue; // sockets, devices, ...
        const isDir = kind === "dir" || linkIsDir === true;
        if (isDir && DEFAULT_SKIP_DIRS.has(d.name)) continue;
        const rel = toRel(cwd, abs);
        if (ign.ignored(rel, isDir)) continue;
        const entry: WalkEntry = { abs, rel, relToStart: toRel(startAbs, abs), depth, kind };
        if (kind === "link") entry.linkIsDir = linkIsDir;
        if (kind === "file") entry.size = await fs.stat(abs).then((s) => s.size, () => 0);
        yield entry;
        if (kind === "dir" && depth < maxDepth) yield* walkDir(abs, depth + 1);
      }
    } finally {
      if (loaded) ign.pop();
    }
  }

  yield* walkDir(startAbs, 1);
}
