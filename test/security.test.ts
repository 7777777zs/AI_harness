// Path-restriction tests: call the tools directly with a temp directory as cwd. No API calls.
// Note: run_shell is not path-restricted by design and is not covered here.
// C4/C4b/C5 cover the symlink/junction escape (TEST_REPORT.md P1), fixed in resolveInCwd by
// resolving links before the containment check. C8-C11 apply the restriction to the Phase 3
// tools (list_dir, glob, grep, edit_file, read_file offset/limit).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "../src/tools/readFile.js";
import { writeFile } from "../src/tools/writeFile.js";
import { listDir } from "../src/tools/listDir.js";
import { glob } from "../src/tools/glob.js";
import { grep } from "../src/tools/grep.js";
import { editFile } from "../src/tools/editFile.js";
import type { ToolContext } from "../src/types.js";

const SECRET = "outside-secret-content";
const OUTSIDE_ERROR = /outside the working directory/;

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** base/outside.txt is outside the sandbox; base/work is the cwd. */
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-sec-"));
  created.push(base);
  const cwd = path.join(base, "work");
  fs.mkdirSync(cwd);
  const outsideFile = path.join(base, "outside.txt");
  fs.writeFileSync(outsideFile, SECRET);
  const outsideDir = path.join(base, "outside-dir");
  fs.mkdirSync(outsideDir);
  let confirms = 0;
  const ctx: ToolContext = {
    cwd,
    confirm: async () => {
      confirms++;
      return true;
    },
  };
  return { base, cwd, outsideFile, outsideDir, ctx, confirms: () => confirms };
}

/** Try to create a symlink; returns false if the OS does not allow it (e.g. Windows without Developer Mode). */
function trySymlink(target: string, link: string, type: "file" | "dir" | "junction"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}

/** A directory link: a real symlink where allowed, otherwise a junction on Windows. */
function dirLink(target: string, link: string): string {
  if (trySymlink(target, link, "dir")) return "symlink";
  if (process.platform === "win32" && trySymlink(target, link, "junction")) return "junction";
  throw new Error("cannot create a directory link on this system");
}

async function assertRefused(p: string, s = setup()) {
  await assert.rejects(readFile.execute({ path: p }, s.ctx), OUTSIDE_ERROR, `read_file("${p}") must be refused`);
  await assert.rejects(
    writeFile.execute({ path: p, content: "pwned" }, s.ctx),
    OUTSIDE_ERROR,
    `write_file("${p}") must be refused`,
  );
  assert.equal(fs.readFileSync(s.outsideFile, "utf8"), SECRET, "outside file unchanged");
  assert.equal(s.confirms(), 0, "refused before asking for confirmation");
}

test("C1: relative escape ../outside.txt is refused", async () => {
  await assertRefused("../outside.txt");
});

test("C2: disguised escape sub/../../outside.txt is refused", async () => {
  await assertRefused("sub/../../outside.txt");
  await assertRefused("./sub/./../../outside.txt");
});

test("C2b: backslash escape ..\\outside.txt is refused on Windows", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  await assertRefused("..\\outside.txt");
  await assertRefused("sub\\..\\..\\outside.txt");
});

test("C2c: a sibling directory sharing the cwd's name prefix is refused", async () => {
  // cwd is .../work; .../work-evil must not be treated as inside it.
  await assertRefused("../work-evil/x.txt");
});

test("C3: absolute paths outside cwd are refused", async () => {
  const s = setup();
  await assertRefused("/etc/passwd", s);
  await assertRefused(s.outsideFile, s);
  if (process.platform === "win32") {
    await assertRefused("C:\\Windows\\win.ini", s);
    await assertRefused("Z:\\elsewhere.txt", s); // other drive letter
  }
});

test("C3b: an absolute path that is inside cwd is allowed", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.cwd, "in.txt"), "inside");
  assert.equal(await readFile.execute({ path: path.join(s.cwd, "in.txt") }, s.ctx), "inside");
});

test("C4: a file symlink inside cwd pointing outside is refused by read_file and write_file", async (t) => {
  const s = setup();
  const link = path.join(s.cwd, "link.txt");
  if (!trySymlink(s.outsideFile, link, "file")) {
    t.skip("file symlinks need admin rights or Developer Mode on this system");
    return;
  }
  await assert.rejects(readFile.execute({ path: "link.txt" }, s.ctx), OUTSIDE_ERROR, "read through symlink");
  await assert.rejects(writeFile.execute({ path: "link.txt", content: "pwned" }, s.ctx), OUTSIDE_ERROR, "write through symlink");
  assert.equal(fs.readFileSync(s.outsideFile, "utf8"), SECRET);
});

test("C4b: reading an outside file through a linked directory inside cwd is refused", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.outsideDir, "secret.txt"), SECRET);
  dirLink(s.outsideDir, path.join(s.cwd, "linked"));
  await assert.rejects(readFile.execute({ path: "linked/secret.txt" }, s.ctx), OUTSIDE_ERROR);
});

test("C5: writing a file through a linked directory inside cwd that points outside is refused", async () => {
  const s = setup();
  dirLink(s.outsideDir, path.join(s.cwd, "linked"));
  await assert.rejects(writeFile.execute({ path: "linked/new.txt", content: "pwned" }, s.ctx), OUTSIDE_ERROR);
  assert.equal(fs.existsSync(path.join(s.outsideDir, "new.txt")), false, "no file created outside cwd");
});

test("C6: a legitimate nested path a/b/c.txt can be written and read back", async () => {
  const s = setup();
  const result = await writeFile.execute({ path: "a/b/c.txt", content: "nested content" }, s.ctx);
  assert.match(result, /Wrote 14 bytes/);
  assert.equal(fs.readFileSync(path.join(s.cwd, "a", "b", "c.txt"), "utf8"), "nested content", "content really written");
  assert.equal(await readFile.execute({ path: "a/b/c.txt" }, s.ctx), "nested content");
  assert.equal(s.confirms(), 1, "write_file asked for confirmation once");
});

test("C7: a denied write_file does not touch the disk", async () => {
  const s = setup();
  const ctx: ToolContext = { cwd: s.cwd, confirm: async () => false };
  assert.equal(await writeFile.execute({ path: "a/b/denied.txt", content: "x" }, ctx), "User denied this action");
  assert.equal(fs.existsSync(path.join(s.cwd, "a")), false);
});

// ---- Phase 3 tools -------------------------------------------------------------------------

/** Every path-taking tool call that must be refused for `p` (`p` as a file or directory). */
function pathCalls(p: string, ctx: ToolContext) {
  return [
    ["read_file", () => readFile.execute({ path: p }, ctx)],
    ["read_file offset", () => readFile.execute({ path: p, offset: 1, limit: 5 }, ctx)],
    ["list_dir", () => listDir.execute({ path: p }, ctx)],
    ["glob", () => glob.execute({ pattern: "**/*", path: p }, ctx)],
    ["grep", () => grep.execute({ pattern: "secret", path: p }, ctx)],
    ["edit_file", () => editFile.execute({ path: p, old_str: "outside", new_str: "pwned" }, ctx)],
  ] as const;
}

async function assertAllRefused(p: string, s: ReturnType<typeof setup>) {
  for (const [name, run] of pathCalls(p, s.ctx)) {
    await assert.rejects(run(), OUTSIDE_ERROR, `${name}("${p}") must be refused`);
  }
  assert.equal(fs.readFileSync(s.outsideFile, "utf8"), SECRET, "outside file unchanged");
  assert.equal(s.confirms(), 0, "refused before asking for confirmation");
}

test("C8: every new tool refuses relative, backslash and absolute escapes", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.outsideDir, "secret.txt"), SECRET);
  for (const p of ["..", "../outside.txt", "sub/../../outside-dir", "..\\outside.txt", s.outsideFile, s.outsideDir]) {
    await assertAllRefused(p, s);
  }
});

test("C9: every new tool refuses paths through a directory link pointing outside", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.outsideDir, "secret.txt"), SECRET);
  dirLink(s.outsideDir, path.join(s.cwd, "linked"));
  await assertAllRefused("linked", s);
  await assertAllRefused("linked/secret.txt", s);
  await assertAllRefused("linked\\secret.txt", s);
  assert.equal(fs.readFileSync(path.join(s.outsideDir, "secret.txt"), "utf8"), SECRET);
});

test("C10: walking cwd never follows a directory link to outside content", async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.outsideDir, "secret.txt"), SECRET);
  fs.writeFileSync(path.join(s.cwd, "inside.txt"), "inside");
  dirLink(s.outsideDir, path.join(s.cwd, "linked"));
  const listing = await listDir.execute({ depth: 5 }, s.ctx);
  assert.match(listing, /^linked\/ \(link, not followed\)$/m);
  assert.doesNotMatch(listing, /secret/);
  assert.doesNotMatch(await glob.execute({ pattern: "**/*" }, s.ctx), /secret/);
  const g = await grep.execute({ pattern: "outside-secret" }, s.ctx);
  assert.match(g, /^No matches/);
});

test("C11: a dangling link inside cwd is refused (writing through it could create a file outside)", async () => {
  const s = setup();
  const target = path.join(s.outsideDir, "gone");
  fs.mkdirSync(target);
  dirLink(target, path.join(s.cwd, "dangling"));
  fs.rmdirSync(target);
  await assert.rejects(writeFile.execute({ path: "dangling/new.txt", content: "pwned" }, s.ctx), OUTSIDE_ERROR);
  assert.equal(fs.existsSync(target), false, "nothing created outside cwd");
});
