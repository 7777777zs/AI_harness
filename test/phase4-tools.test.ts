// Phase 4, Part B: edit_file/read_file/write_file line endings, BOM and encoding (B1, B2), and
// read-only tool edge cases (B3). No API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/types.js";
import { editFile } from "../src/tools/editFile.js";
import { readFile } from "../src/tools/readFile.js";
import { writeFile } from "../src/tools/writeFile.js";
import { grep } from "../src/tools/grep.js";
import { glob } from "../src/tools/glob.js";
import { listDir } from "../src/tools/listDir.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function sandbox(files: Record<string, string | Buffer> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-p4t-"));
  created.push(dir);
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}
const ctx = (cwd: string): ToolContext => ({ cwd, confirm: async () => true });
const bytes = (dir: string, p: string) => fs.readFileSync(path.join(dir, p));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---- B1/B2: edit_file ----

test("B2: CRLF file — the edit succeeds and only the edited line's bytes change", async () => {
  const original = "line one\r\nline two\r\ntimeout = 30\r\nline four\r\n";
  const dir = sandbox({ "a.conf": original });
  const r = await editFile.execute({ path: "a.conf", old_str: "timeout = 30", new_str: "timeout = 60" }, ctx(dir));
  assert.equal(r, "Edited a.conf: replaced 1 occurrence (line 3)");
  assert.deepEqual(bytes(dir, "a.conf"), Buffer.from(original.replace("timeout = 30", "timeout = 60")));
});

test("B2: a multi-line old_str copied from read_file (LF) matches a CRLF file; new lines get CRLF", async () => {
  const original = "a\r\nb\r\nc\r\nd\r\n";
  const dir = sandbox({ "f.txt": original });
  const shown = await readFile.execute({ path: "f.txt" }, ctx(dir));
  assert.equal(shown, "a\nb\nc\nd\n");
  await editFile.execute({ path: "f.txt", old_str: "b\nc", new_str: "B\nX\nC" }, ctx(dir));
  assert.equal(bytes(dir, "f.txt").toString(), "a\r\nB\r\nX\r\nC\r\nd\r\n");
});

test("B2: a UTF-8 BOM is preserved, and old_str on line 1 matches without it", async () => {
  const dir = sandbox({ "bom.txt": Buffer.concat([BOM, Buffer.from("first line\nsecond line\n")]) });
  assert.equal(await readFile.execute({ path: "bom.txt" }, ctx(dir)), "first line\nsecond line\n");
  await editFile.execute({ path: "bom.txt", old_str: "first line", new_str: "FIRST line" }, ctx(dir));
  assert.deepEqual(bytes(dir, "bom.txt"), Buffer.concat([BOM, Buffer.from("FIRST line\nsecond line\n")]));
});

test("B2: Chinese and emoji content in old_str and in the file", async () => {
  const dir = sandbox({ "zh.md": "# 标题\n问候：你好 👋 世界\n结束 ✅\n" });
  const r = await editFile.execute({ path: "zh.md", old_str: "你好 👋 世界", new_str: "再见 🎉 世界" }, ctx(dir));
  assert.equal(r, "Edited zh.md: replaced 1 occurrence (line 2)");
  assert.equal(bytes(dir, "zh.md").toString("utf8"), "# 标题\n问候：再见 🎉 世界\n结束 ✅\n");
});

test("B2: old_str that differs only in trailing whitespace fails with a whitespace hint", async () => {
  const dir = sandbox({ "w.py": "x = 1\nvalue = 1   \nnext = 2\n" });
  await assert.rejects(
    editFile.execute({ path: "w.py", old_str: "value = 1\nnext = 2", new_str: "value = 5\nnext = 2" }, ctx(dir)),
    /old_str not found in w\.py, but it matches \(line 2\) if trailing whitespace is ignored: the whitespace at the end of some lines differs/,
  );
  assert.equal(bytes(dir, "w.py").toString(), "x = 1\nvalue = 1   \nnext = 2\n", "file untouched");
  await assert.rejects(
    editFile.execute({ path: "w.py", old_str: "not here at all", new_str: "y" }, ctx(dir)),
    /old_str not found in w\.py\. It must match the file exactly/,
  );
});

test("B2: edits near the start and the end of a ~200 KB file change only those lines", async () => {
  const lines = Array.from({ length: 4_000 }, (_, i) => `line ${String(i + 1).padStart(5, "0")}: ${"z".repeat(40)}`);
  const original = lines.join("\r\n") + "\r\n";
  assert.ok(original.length > 190_000);
  const dir = sandbox({ "big.txt": original });
  const t0 = Date.now();
  await editFile.execute({ path: "big.txt", old_str: "line 00003:", new_str: "LINE 00003:" }, ctx(dir));
  await editFile.execute({ path: "big.txt", old_str: "line 03998:", new_str: "LINE 03998:" }, ctx(dir));
  const ms = Date.now() - t0;
  const expected = original.replace("line 00003:", "LINE 00003:").replace("line 03998:", "LINE 03998:");
  assert.deepEqual(bytes(dir, "big.txt"), Buffer.from(expected));
  assert.ok(ms < 2_000, `two edits took ${ms} ms`);
});

test("B2: an empty new_str deletes text (a whole line, with its line ending)", async () => {
  const dir = sandbox({ "d.txt": "keep 1\r\ndrop me\r\nkeep 2\r\n" });
  const r = await editFile.execute({ path: "d.txt", old_str: "drop me\n", new_str: "" }, ctx(dir));
  assert.match(r, /text deleted/);
  assert.equal(bytes(dir, "d.txt").toString(), "keep 1\r\nkeep 2\r\n");
  // Deleting within a line keeps the line.
  await editFile.execute({ path: "d.txt", old_str: " 2", new_str: "" }, ctx(dir));
  assert.equal(bytes(dir, "d.txt").toString(), "keep 1\r\nkeep\r\n");
});

test("B2: file changed on disk between read_file and edit_file — matches current content or fails clearly", async () => {
  const dir = sandbox({ "c.txt": "alpha\nbeta\ngamma\n" });
  await readFile.execute({ path: "c.txt" }, ctx(dir));
  // Someone else edits another line: the edit still applies, and their change survives.
  fs.writeFileSync(path.join(dir, "c.txt"), "alpha\nbeta\nGAMMA (changed elsewhere)\n");
  await editFile.execute({ path: "c.txt", old_str: "beta", new_str: "BETA" }, ctx(dir));
  assert.equal(bytes(dir, "c.txt").toString(), "alpha\nBETA\nGAMMA (changed elsewhere)\n");
  // Someone else changes the target text: the edit fails and nothing is written.
  fs.writeFileSync(path.join(dir, "c.txt"), "alpha\nbeta was rewritten\n");
  await assert.rejects(editFile.execute({ path: "c.txt", old_str: "BETA", new_str: "x" }, ctx(dir)), /old_str not found in c\.txt/);
  assert.equal(bytes(dir, "c.txt").toString(), "alpha\nbeta was rewritten\n");
});

test("B1: mixed line endings — untouched lines keep theirs, edited lines use the dominant style", async () => {
  const dir = sandbox({ "m.txt": "a\r\nb\nc\r\nd\r\n" }); // 3 CRLF, 1 LF -> dominant CRLF
  await editFile.execute({ path: "m.txt", old_str: "c", new_str: "C" }, ctx(dir));
  assert.equal(bytes(dir, "m.txt").toString(), "a\r\nb\nC\r\nd\r\n", "the LF line b is untouched");
  await editFile.execute({ path: "m.txt", old_str: "b", new_str: "B" }, ctx(dir));
  assert.equal(bytes(dir, "m.txt").toString(), "a\r\nB\r\nC\r\nd\r\n", "the edited line takes the dominant CRLF");
});

test("B1: replace_all on a CRLF file keeps every untouched byte", async () => {
  const original = "x = old\r\ny = 1\r\nz = old\r\n";
  const dir = sandbox({ "r.txt": original });
  const r = await editFile.execute({ path: "r.txt", old_str: "old", new_str: "new", replace_all: true }, ctx(dir));
  assert.equal(r, "Edited r.txt: replaced 2 occurrences (lines 1, 3)");
  assert.equal(bytes(dir, "r.txt").toString(), original.replaceAll("old", "new"));
});

test("B1: read_file line numbers match the file's real lines (CRLF, BOM)", async () => {
  const dir = sandbox({ "n.txt": Buffer.concat([BOM, Buffer.from("one\r\ntwo\r\nthree\r\n")]) });
  assert.equal(await readFile.execute({ path: "n.txt", offset: 1, limit: 2 }, ctx(dir)), "     1\tone\n     2\ttwo\n[lines 1-2 of 3; use offset=3 to continue]");
});

// ---- B1: write_file preserves the style of existing files ----

test("B1: a CRLF+BOM file read with read_file and written back unchanged is byte-identical", async () => {
  const original = Buffer.concat([BOM, Buffer.from("alpha\r\nbeta\r\ngamma\r\n")]);
  const dir = sandbox({ "s.txt": original });
  const shown = await readFile.execute({ path: "s.txt" }, ctx(dir));
  assert.equal(shown, "alpha\nbeta\ngamma\n");
  await writeFile.execute({ path: "s.txt", content: shown }, ctx(dir));
  assert.deepEqual(bytes(dir, "s.txt"), original);
});

test("B1: write_file keeps the dominant ending and BOM when overwriting; new files are LF without BOM", async () => {
  const dir = sandbox({ "old.txt": Buffer.concat([BOM, Buffer.from("a\r\nb\r\n")]) });
  await writeFile.execute({ path: "old.txt", content: "x\ny\nz\n" }, ctx(dir));
  assert.deepEqual(bytes(dir, "old.txt"), Buffer.concat([BOM, Buffer.from("x\r\ny\r\nz\r\n")]));
  await writeFile.execute({ path: "new/file.txt", content: "p\r\nq\r\n" }, ctx(dir));
  assert.equal(bytes(dir, "new/file.txt").toString(), "p\nq\n");
});

// ---- B3: read-only tools ----

test("B3: grep and glob respect nested .gitignore files with negation (!keep.log)", async () => {
  const dir = sandbox({
    ".gitignore": "*.log\n",
    "root.log": "MARK root",
    "src/app.txt": "MARK app",
    "sub/.gitignore": "!keep.log\n",
    "sub/keep.log": "MARK keep",
    "sub/other.log": "MARK other",
  });
  const g = await glob.execute({ pattern: "**/*.log" }, ctx(dir));
  assert.equal(g.trim(), "sub/keep.log");
  const s = await grep.execute({ pattern: "MARK" }, ctx(dir));
  const files = [...s.matchAll(/^([^:\n]+):\d+: /gm)].map((m) => m[1]).sort();
  assert.deepEqual(files, ["src/app.txt", "sub/keep.log"]);
});

test("B3: grep with an invalid regex returns a clear error instead of crashing", async () => {
  const dir = sandbox({ "a.txt": "x" });
  await assert.rejects(grep.execute({ pattern: "([unclosed" }, ctx(dir)), /^Error: Invalid regex "\(\[unclosed": /);
});

test("B3: list_dir on a directory with 10k+ files finishes quickly and is capped", async (t) => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, "many"));
  for (let i = 0; i < 10_500; i++) fs.writeFileSync(path.join(dir, "many", `f${i}.txt`), "");
  const t0 = Date.now();
  const out = await listDir.execute({ path: "many", depth: 1 }, ctx(dir));
  const ms = Date.now() - t0;
  t.diagnostic(`list_dir over 10,500 files: ${ms} ms`);
  assert.ok(ms < 5_000, `${ms} ms`);
  assert.match(out, /\[10,?000 more entries omitted \(limit 500\)/);
  assert.equal(out.split("\n").filter((l) => /^many\/f\d+\.txt/.test(l)).length, 500);
});

test("B3: non-ASCII (Chinese) file and directory names are listed and searchable", async () => {
  const dir = sandbox({ "文档/说明.md": "内容：关键词 在这里\n", "src/主程序.py": "print('你好')\n" });
  const listing = await listDir.execute({ path: ".", depth: 3 }, ctx(dir));
  assert.match(listing, /^文档\/$/m);
  assert.match(listing, /^文档\/说明\.md \(\d+ B\)$/m);
  assert.equal((await glob.execute({ pattern: "**/*.md" }, ctx(dir))).trim(), "文档/说明.md");
  assert.match(await grep.execute({ pattern: "关键词" }, ctx(dir)), /^文档\/说明\.md:1: 内容：关键词 在这里$/m);
  assert.match(await grep.execute({ pattern: "你好" }, ctx(dir)), /^src\/主程序\.py:1: /m);
});

test("B3: grep over a generated repo of ~5,000 files completes within a few seconds", async (t) => {
  const dir = sandbox();
  for (let d = 0; d < 50; d++) {
    const sub = path.join(dir, `pkg${d}`);
    fs.mkdirSync(sub);
    for (let f = 0; f < 100; f++) {
      const body = `// module ${d}.${f}\nexport function fn${f}() { return ${f}; }\n` + (f === 42 ? "// NEEDLE_7731\n" : "") + "// filler\n".repeat(20);
      fs.writeFileSync(path.join(sub, `m${f}.ts`), body);
    }
  }
  const t0 = Date.now();
  const out = await grep.execute({ pattern: "NEEDLE_7731", max_results: 100 }, ctx(dir));
  const ms = Date.now() - t0;
  t.diagnostic(`grep over 5,000 files: ${ms} ms`);
  assert.equal([...out.matchAll(/^pkg\d+\/m42\.ts:\d+: /gm)].length, 50);
  assert.ok(ms < 5_000, `${ms} ms`);
});
