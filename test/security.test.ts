// Path-restriction tests: call the tools directly with a temp directory as cwd. No API calls.
// Note: run_shell is not path-restricted by design and is not covered here.
// Tests marked KNOWN_BUG document a real sandbox escape (see TEST_REPORT.md). They run and
// report "# TODO" without failing the suite; remove the marker once resolveInCwd is fixed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "../src/tools/readFile.js";
import { writeFile } from "../src/tools/writeFile.js";
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

const KNOWN_BUG = { todo: "KNOWN BUG (TEST_REPORT.md P1): resolveInCwd does not resolve symlinks/junctions" };

test("C4: a file symlink inside cwd pointing outside is refused by read_file and write_file", KNOWN_BUG, async (t) => {
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

test("C4b: reading an outside file through a linked directory inside cwd is refused", KNOWN_BUG, async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.outsideDir, "secret.txt"), SECRET);
  dirLink(s.outsideDir, path.join(s.cwd, "linked"));
  await assert.rejects(readFile.execute({ path: "linked/secret.txt" }, s.ctx), OUTSIDE_ERROR);
});

test("C5: writing a file through a linked directory inside cwd that points outside is refused", KNOWN_BUG, async () => {
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
