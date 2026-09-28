// Tests for the exploration/editing tools: list_dir, glob, grep, edit_file, read_file offset/limit.
// Tools are called directly with a temp directory as cwd; no API calls. Path-restriction tests
// for these tools are in security.test.ts (C8-C11).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDir } from "../src/tools/listDir.js";
import { glob } from "../src/tools/glob.js";
import { grep } from "../src/tools/grep.js";
import { editFile } from "../src/tools/editFile.js";
import { readFile } from "../src/tools/readFile.js";
import { globToRegExp } from "../src/tools/globMatch.js";
import { truncate } from "../src/tools/util.js";
import { tools } from "../src/tools/index.js";
import { runAgent } from "../src/agent.js";
import type { LLMClient, LLMResponse, Message } from "../src/llm/types.js";
import { DENIED, type ToolContext } from "../src/types.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function sandbox(files: Record<string, string | Buffer> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-tools-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function context(cwd: string, answer = true) {
  const summaries: string[] = [];
  const ctx: ToolContext = {
    cwd,
    confirm: async (summary) => {
      summaries.push(summary);
      return answer;
    },
  };
  return { ctx, summaries };
}

const outLines = (s: string) => s.split("\n");

/** A project exercising the default skip list and .gitignore rules. */
function project(): string {
  return sandbox({
    "README.md": "# demo\n",
    "src/app.ts": "export const app = 1;\n",
    "src/lib/util.ts": "export function helper() {}\n",
    "src/lib/deep/deeper/x.ts": "x\n",
    "debug.log": "log\n",
    "keep.log": "kept\n",
    "generated/out.ts": "generated\n",
    "sub/local.txt": "nested-ignored\n",
    "sub/shared.txt": "shared\n",
    "sub/.gitignore": "local.txt\n",
    ".gitignore": "*.log\n!keep.log\ngenerated/\n",
    "node_modules/pkg/index.js": "module\n",
    ".git/HEAD": "ref\n",
    ".venv/lib/site.py": "venv\n",
    "venv/lib/site.py": "venv\n",
    "src/__pycache__/app.pyc": "pyc\n",
    "dist/bundle.js": "dist\n",
    "build/out.js": "build\n",
  });
}

const SKIPPED = /node_modules|\.git\/|\.venv|venv|__pycache__|dist|build|generated|debug\.log|local\.txt/;

test("tools are registered in the tool list", () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read_file", "list_dir", "glob", "grep", "edit_file", "write_file", "run_shell"],
  );
});

// ---- list_dir -------------------------------------------------------------------------------

test("list_dir: skips the default directories and .gitignore'd paths, including nested .gitignore and negation", async () => {
  const dir = project();
  const out = await listDir.execute({ depth: 5 }, context(dir).ctx);
  assert.doesNotMatch(out, SKIPPED);
  for (const expected of [".gitignore", "keep.log (5 B)", "README.md (7 B)", "src/", "src/app.ts (22 B)", "src/lib/deep/deeper/x.ts (2 B)", "sub/shared.txt (7 B)"]) {
    assert.ok(outLines(out).includes(expected) || out.includes(expected), `missing ${expected}:\n${out}`);
  }
});

test("list_dir: default depth is 2, directories end with '/', files show sizes", async () => {
  const dir = project();
  const lines = outLines(await listDir.execute({}, context(dir).ctx));
  assert.ok(lines.includes("src/"));
  assert.ok(lines.includes("src/lib/"));
  assert.ok(lines.includes("src/app.ts (22 B)"));
  assert.ok(!lines.some((l) => l.startsWith("src/lib/util.ts")), "depth 3 not shown at default depth 2");
  const one = outLines(await listDir.execute({ depth: 1 }, context(dir).ctx));
  assert.ok(one.includes("src/") && !one.some((l) => l.startsWith("src/app")), "depth 1 shows only direct children");
  // depth is clamped to 5
  const deep = await listDir.execute({ depth: 99 }, context(dir).ctx);
  assert.match(deep, /^src\/lib\/deep\/deeper\/x\.ts/m);
});

test("list_dir: KB/MB sizes and an entry cap with an omitted count", async () => {
  const files: Record<string, string> = { "big.bin": "x".repeat(2048) };
  for (let i = 0; i < 520; i++) files[`many/f${String(i).padStart(3, "0")}.txt`] = "";
  const dir = sandbox(files);
  const out = await listDir.execute({ path: "." }, context(dir).ctx);
  assert.match(out, /^big\.bin \(2\.0 KB\)$/m);
  const lines = outLines(out);
  assert.equal(lines.length, 501);
  assert.equal(lines.at(-1), "[22 more entries omitted (limit 500); list a subdirectory or lower depth]");
});

test("list_dir: Windows-style input paths work and output uses forward slashes relative to cwd", async () => {
  const dir = project();
  for (const p of ["src\\lib", "src/lib/", path.join(dir, "src", "lib"), ".\\src\\lib"]) {
    const out = await listDir.execute({ path: p }, context(dir).ctx);
    assert.ok(outLines(out).includes("src/lib/util.ts (28 B)"), `path ${p}:\n${out}`);
    assert.doesNotMatch(out, /\\/);
  }
});

test("list_dir: an explicitly requested ignored directory is listed; errors for files and empty dirs", async () => {
  const dir = project();
  assert.equal(await listDir.execute({ path: "node_modules/pkg" }, context(dir).ctx), "node_modules/pkg/index.js (7 B)");
  assert.equal(await listDir.execute({ path: "generated" }, context(dir).ctx), "generated/out.ts (10 B)");
  fs.mkdirSync(path.join(dir, "empty"));
  assert.equal(await listDir.execute({ path: "empty" }, context(dir).ctx), "(empty directory)");
  await assert.rejects(listDir.execute({ path: "README.md" }, context(dir).ctx), /Not a directory: README\.md/);
  await assert.rejects(listDir.execute({ path: "missing" }, context(dir).ctx), /ENOENT/);
});

// ---- glob -----------------------------------------------------------------------------------

test("globToRegExp: *, **, ?, classes, braces, anchoring", () => {
  const m = (g: string, p: string) => globToRegExp(g, false).test(p);
  assert.ok(m("*.py", "a.py") && m("*.py", "x/y/a.py"), "no slash: any depth");
  assert.ok(!m("*.py", "a.pyc"));
  assert.ok(m("src/*.ts", "src/a.ts") && !m("src/*.ts", "src/x/a.ts") && !m("src/*.ts", "lib/src/a.ts"), "slash: anchored");
  assert.ok(m("**/*.ts", "a.ts") && m("**/*.ts", "a/b/c.ts"));
  assert.ok(m("src/**/*.ts", "src/a.ts") && m("src/**/*.ts", "src/a/b/c.ts") && !m("src/**/*.ts", "lib/a.ts"));
  assert.ok(m("src/**", "src/a/b.txt"));
  assert.ok(m("file?.txt", "file1.txt") && !m("file?.txt", "file10.txt"));
  assert.ok(m("[ab]*.js", "a1.js") && !m("[ab]*.js", "c1.js") && m("[!ab]*.js", "c1.js"));
  assert.ok(m("*.{js,ts}", "x.ts") && m("*.{js,ts}", "x.js") && !m("*.{js,ts}", "x.py"));
  assert.ok(m("src\\**\\*.ts", "src/a/b.ts"), "backslashes in the pattern act as '/'");
  assert.ok(m("./src/*.ts", "src/a.ts"));
  assert.ok(m("a+b(1).txt", "a+b(1).txt") && !m("a.txt", "abtxt"), "regex characters are literal");
  assert.ok(globToRegExp("*.PY", true).test("a.py"), "case-insensitive option");
  assert.throws(() => globToRegExp("{a,b"), /unclosed/);
});

test("glob: sorted matches, same ignore rules, forward slashes", async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, "generated", "x.ts"), "");
  const out = await glob.execute({ pattern: "**/*.ts" }, context(dir).ctx);
  assert.deepEqual(outLines(out), ["src/app.ts", "src/lib/deep/deeper/x.ts", "src/lib/util.ts"]);
  assert.deepEqual(outLines(await glob.execute({ pattern: "*.js" }, context(dir).ctx)), [`No files match "*.js"`]);
  assert.deepEqual(outLines(await glob.execute({ pattern: "*.log" }, context(dir).ctx)), ["keep.log"]);
});

test("glob: path restricts the search and anchored patterns are relative to it (Windows-style path)", async () => {
  const dir = project();
  assert.deepEqual(outLines(await glob.execute({ pattern: "*.ts", path: "src\\lib" }, context(dir).ctx)), [
    "src/lib/deep/deeper/x.ts",
    "src/lib/util.ts",
  ]);
  assert.deepEqual(outLines(await glob.execute({ pattern: "lib/*.ts", path: "src" }, context(dir).ctx)), ["src/lib/util.ts"]);
  assert.match(await glob.execute({ pattern: "*.zz", path: "src" }, context(dir).ctx), /No files match "\*\.zz" under src/);
});

test("glob: caps results at 500 and reports the omitted count", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 510; i++) files[`d/f${String(i).padStart(3, "0")}.txt`] = "";
  const dir = sandbox(files);
  const lines = outLines(await glob.execute({ pattern: "*.txt" }, context(dir).ctx));
  assert.equal(lines.length, 501);
  assert.equal(lines[0], "d/f000.txt");
  assert.match(lines.at(-1)!, /^\[10 more matches omitted \(limit 500\)/);
});

// ---- grep -----------------------------------------------------------------------------------

function grepProject(): string {
  return sandbox({
    "src/a.ts": "import { fetchUser } from './b';\nconst u = fetchUser(1);\nconsole.log(u);\n",
    "src/b.ts": "export function fetchUser(id: number) {\n  return { id };\n}\n",
    "src/c.py": "def fetch_user(id):\n    return FetchUser(id)\n",
    "docs/notes.md": "fetchUser is documented here\n",
    "node_modules/lib/index.js": "fetchUser()\n",
    "generated/x.ts": "fetchUser()\n",
    ".gitignore": "generated/\n",
  });
}

test("grep: regex search with 'path:line: text' output, sorted, same ignore rules", async () => {
  const dir = grepProject();
  const out = await grep.execute({ pattern: "fetchUser\\(" }, context(dir).ctx);
  assert.deepEqual(outLines(out), [
    "src/a.ts:2: const u = fetchUser(1);",
    "src/b.ts:1: export function fetchUser(id: number) {",
    "[2 matches in 2 files]",
  ]);
});

test("grep: case_insensitive, glob filter, single-file path, Windows-style path", async () => {
  const dir = grepProject();
  const ci = await grep.execute({ pattern: "fetchuser\\(", case_insensitive: true, glob: "*.py" }, context(dir).ctx);
  assert.deepEqual(outLines(ci), ["src/c.py:2:     return FetchUser(id)", "[1 match in 1 file]"]);
  const md = await grep.execute({ pattern: "fetchUser", glob: "docs/*.md" }, context(dir).ctx);
  assert.deepEqual(outLines(md), ["docs/notes.md:1: fetchUser is documented here", "[1 match in 1 file]"]);
  const one = await grep.execute({ pattern: "return", path: "src\\b.ts" }, context(dir).ctx);
  assert.deepEqual(outLines(one), ["src/b.ts:2:   return { id };", "[1 match in 1 file]"]);
  assert.match(await grep.execute({ pattern: "nothing-here" }, context(dir).ctx), /^No matches for \/nothing-here\/ in \.$/);
});

test("grep: context lines use 'path-line-' and '--' between separate groups", async () => {
  const body = Array.from({ length: 20 }, (_, i) => (i === 2 || i === 4 || i === 15 ? `hit ${i + 1}` : `line ${i + 1}`));
  const dir = sandbox({ "f.txt": body.join("\n") + "\n", "g.txt": "hit g\n" });
  const out = await grep.execute({ pattern: "^hit", context_lines: 1 }, context(dir).ctx);
  assert.deepEqual(outLines(out), [
    "f.txt-2- line 2",
    "f.txt:3: hit 3",
    "f.txt-4- line 4",
    "f.txt:5: hit 5",
    "f.txt-6- line 6",
    "--",
    "f.txt-15- line 15",
    "f.txt:16: hit 16",
    "f.txt-17- line 17",
    "--",
    "g.txt:1: hit g",
    "[4 matches in 2 files]",
  ]);
  // context_lines is clamped to 5
  const clamped = await grep.execute({ pattern: "hit 16", context_lines: 50 }, context(dir).ctx);
  assert.equal(outLines(clamped).length, 5 + 1 + 4 + 1); // lines 11-20 (file ends at 20) + summary
});

test("grep: max_results caps the matching lines and says more exist", async () => {
  const dir = sandbox({ "a.txt": Array.from({ length: 30 }, (_, i) => `match ${i}`).join("\n"), "b.txt": "match b\n" });
  const out = outLines(await grep.execute({ pattern: "match", max_results: 5 }, context(dir).ctx));
  assert.equal(out.length, 6);
  assert.equal(out[4], "a.txt:5: match 4");
  assert.equal(out.at(-1), "[5 matches in 1 file; stopped at max_results=5; more matches exist]");
  const def = outLines(await grep.execute({ pattern: "match" }, context(dir).ctx));
  assert.equal(def.at(-1), "[31 matches in 2 files]", "default 100 is not hit");
});

test("grep: skips binary files and files over 1 MB, and reports them", async () => {
  const dir = sandbox({
    "bin.dat": Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]), // "needle\0\1"
    "big.txt": "needle\n" + "x".repeat(1024 * 1024),
    "ok.txt": "needle here\n",
  });
  const out = await grep.execute({ pattern: "needle" }, context(dir).ctx);
  assert.deepEqual(outLines(out), ["ok.txt:1: needle here", "[1 match in 1 file; 1 binary file skipped; 1 file over 1 MB skipped]"]);
});

test("grep: invalid regex gives a clear error; very long lines are clipped", async () => {
  const dir = sandbox({ "a.txt": "x".repeat(1000) + "needle\n" });
  await assert.rejects(grep.execute({ pattern: "(unclosed" }, context(dir).ctx), /Invalid regex "\(unclosed"/);
  const out = await grep.execute({ pattern: "needle" }, context(dir).ctx);
  assert.match(out, /^a\.txt:1: x{300} …\[line truncated\]$/m);
});

// ---- edit_file ------------------------------------------------------------------------------

const CODE = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";

test("edit_file: a unique match is replaced after confirmation with a compact diff", async () => {
  const dir = sandbox({ "src/code.js": CODE });
  const { ctx, summaries } = context(dir);
  const result = await editFile.execute(
    { path: "src\\code.js", old_str: "function b() {\n  return 1;", new_str: "function b() {\n  return 2;" },
    ctx,
  );
  assert.equal(result, "Edited src/code.js: replaced 1 occurrence (lines 5-6)");
  assert.equal(fs.readFileSync(path.join(dir, "src/code.js"), "utf8"), CODE.replace("b() {\n  return 1;", "b() {\n  return 2;"));
  assert.equal(summaries.length, 1, "confirmation asked exactly once");
  assert.equal(summaries[0], "edit_file -> src/code.js (1 replacement)\n@@ line 6 @@\n function b() {\n-  return 1;\n+  return 2;");
});

test("edit_file: zero matches fail with a clear error and do not ask or write", async () => {
  const dir = sandbox({ "code.js": CODE });
  const { ctx, summaries } = context(dir);
  await assert.rejects(editFile.execute({ path: "code.js", old_str: "return 3;", new_str: "x" }, ctx), /old_str not found in code\.js/);
  assert.equal(summaries.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "code.js"), "utf8"), CODE);
});

test("edit_file: multiple matches fail with the line numbers unless replace_all", async () => {
  const dir = sandbox({ "code.js": CODE });
  const { ctx, summaries } = context(dir);
  await assert.rejects(
    editFile.execute({ path: "code.js", old_str: "return 1;", new_str: "return 2;" }, ctx),
    /old_str occurs 2 times in code\.js \(lines 2, 6\)\. Include more surrounding lines to make it unique, or set replace_all to true\./,
  );
  assert.equal(summaries.length, 0);
  const result = await editFile.execute({ path: "code.js", old_str: "return 1;", new_str: "return 2;", replace_all: true }, ctx);
  assert.equal(result, "Edited code.js: replaced 2 occurrences (lines 2, 6)");
  assert.equal(fs.readFileSync(path.join(dir, "code.js"), "utf8"), CODE.replaceAll("return 1;", "return 2;"));
  assert.match(summaries[0]!, /^edit_file -> code\.js \(2 replacements\)\n@@ line 2 @@\n-  return 1;\n\+  return 2;\n@@ line 6 @@/);
});

test("edit_file: line numbers account for earlier multi-line replacements", async () => {
  const dir = sandbox({ "t.txt": "x\na\nx\nb\nx\n" });
  const result = await editFile.execute({ path: "t.txt", old_str: "x\n", new_str: "y\ny\n", replace_all: true }, context(dir).ctx);
  assert.equal(result, "Edited t.txt: replaced 3 occurrences (lines 1-2, 4-5, 7-8)");
  assert.equal(fs.readFileSync(path.join(dir, "t.txt"), "utf8"), "y\ny\na\ny\ny\nb\ny\ny\n");
});

test("edit_file: a denied edit returns DENIED and leaves the file untouched", async () => {
  const dir = sandbox({ "code.js": CODE });
  const { ctx, summaries } = context(dir, false);
  assert.equal(await editFile.execute({ path: "code.js", old_str: "function a", new_str: "function z" }, ctx), DENIED);
  assert.equal(summaries.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "code.js"), "utf8"), CODE);
});

test("edit_file: CRLF files match a LF old_str, and the result says so", async () => {
  const crlf = CODE.replace(/\n/g, "\r\n");
  const dir = sandbox({ "win.js": crlf });
  const result = await editFile.execute(
    { path: "win.js", old_str: "function a() {\n  return 1;", new_str: "function a() {\n  return 5;" },
    context(dir).ctx,
  );
  assert.equal(result, "Edited win.js: replaced 1 occurrence (lines 1-2) (matched after normalizing line endings to CRLF)");
  assert.equal(fs.readFileSync(path.join(dir, "win.js"), "utf8"), crlf.replace("return 1;", "return 5;"));
});

test("edit_file: argument errors (empty old_str, identical strings, missing file)", async () => {
  const dir = sandbox({ "code.js": CODE });
  const { ctx } = context(dir);
  await assert.rejects(editFile.execute({ path: "code.js", old_str: "", new_str: "x" }, ctx), /must not be empty/);
  await assert.rejects(editFile.execute({ path: "code.js", old_str: "a", new_str: "a" }, ctx), /identical/);
  await assert.rejects(editFile.execute({ path: "nope.js", old_str: "a", new_str: "b" }, ctx), /ENOENT/);
});

const usage = { inputTokens: 0, outputTokens: 0 };
const final = (text: string): LLMResponse => ({ text, toolCalls: [], usage, raw: null });

function editingClient(): LLMClient {
  let n = 0;
  return {
    async chat(_messages: Message[], toolDefs: unknown[]) {
      if (toolDefs.length === 0) return final("summary");
      if (n++ === 0) {
        return {
          text: null,
          toolCalls: [{ id: "e1", name: "edit_file", args: { path: "code.js", old_str: "function a", new_str: "function z" } }],
          usage,
          raw: null,
        };
      }
      return final("done");
    },
  };
}

test("edit_file through the agent: confirmation is required unless autoApprove", async () => {
  const denied = sandbox({ "code.js": CODE });
  let asked = 0;
  await runAgent({
    task: "x",
    cwd: denied,
    client: editingClient(),
    quiet: true,
    confirm: async () => {
      asked++;
      return false;
    },
  });
  assert.equal(asked, 1, "the user was asked");
  assert.equal(fs.readFileSync(path.join(denied, "code.js"), "utf8"), CODE, "denied edit not applied");

  const approved = sandbox({ "code.js": CODE });
  await runAgent({ task: "x", cwd: approved, client: editingClient(), quiet: true, autoApprove: true });
  assert.equal(fs.readFileSync(path.join(approved, "code.js"), "utf8"), CODE.replace("function a", "function z"));
});

test("truncate with a small max (write_file's 500-char preview) keeps within max and never duplicates", () => {
  const s = "a".repeat(900) + "END";
  const t = truncate(s, 500);
  assert.equal(t.split("\n")[0], "a".repeat(375));
  assert.match(t, /\[\.\.\. truncated: 403 chars \/ 0 lines omitted \(1 lines total\) \.\.\.\]/);
  assert.ok(t.endsWith("a".repeat(122) + "END"));
  assert.equal(truncate("x".repeat(20_000)).length, truncate("x".repeat(20_000), 10_000).length, "default unchanged");
  assert.ok(truncate("x".repeat(20_000)).startsWith("x".repeat(6_000) + "\n["));
});

// ---- read_file offset/limit -----------------------------------------------------------------

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("read_file: without offset/limit the content is returned unchanged", async () => {
  const dir = sandbox({ "a.txt": TEN, "crlf.txt": "a\r\nb\r\n" });
  assert.equal(await readFile.execute({ path: "a.txt" }, context(dir).ctx), TEN);
  assert.equal(await readFile.execute({ path: "crlf.txt" }, context(dir).ctx), "a\r\nb\r\n");
});

test("read_file: offset/limit return numbered lines and a continuation hint", async () => {
  const dir = sandbox({ "a.txt": TEN, "crlf.txt": "a\r\nb\r\n", "empty.txt": "" });
  const { ctx } = context(dir);
  assert.equal(
    await readFile.execute({ path: "a.txt", offset: 3, limit: 2 }, ctx),
    "     3\tline 3\n     4\tline 4\n[lines 3-4 of 10; use offset=5 to continue]",
  );
  assert.equal(await readFile.execute({ path: "a.txt", offset: 9 }, ctx), "     9\tline 9\n    10\tline 10");
  assert.equal(
    await readFile.execute({ path: "a.txt", limit: 1 }, ctx),
    "     1\tline 1\n[lines 1-1 of 10; use offset=2 to continue]",
  );
  assert.equal(await readFile.execute({ path: "a.txt", offset: 8, limit: 50 }, ctx), "     8\tline 8\n     9\tline 9\n    10\tline 10");
  assert.equal(await readFile.execute({ path: "crlf.txt", offset: 1 }, ctx), "     1\ta\n     2\tb", "CR stripped");
  assert.equal(await readFile.execute({ path: "empty.txt", offset: 1 }, ctx), "(empty file)");
  await assert.rejects(readFile.execute({ path: "a.txt", offset: 11 }, ctx), /offset 11 is past the end of the file \(10 lines\)/);
  await assert.rejects(readFile.execute({ path: "a.txt", offset: 1.5 }, ctx), /expected integer/);
});
