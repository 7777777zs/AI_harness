# Workstream B: new built-in tools (branch `phase3-tools`)

*Text from the Workstream B sub-agent's final report. The harness blocked the sub-agent from writing this file itself; it was saved during integration with the user's approval.*

## 1. Integration items for Workstream A

1. **`isListing`:** return true when `toolName` is `"list_dir"` or `"glob"`. The path-ratio heuristic would misfire on short or "No files match" results. These paths should feed the pinned known-files list.
2. **`parseListing` for `list_dir` and `glob`:**
   - Skip lines starting with `[` (footer notes), `(` (`(empty directory)`) or `No files match`.
   - Strip the suffix ` \((\d+ B|\d+\.\d [KM]B|link, not followed)\)$`.
   - What is left is a cwd-relative path with `/`; directories end with `/`.
   - `list_dir` lines are full relative paths, not tree-indented names.
3. **`grep` is not a listing.** Match lines are `path:line: text`, context lines `path-line- text`, groups separated by `--`, and the footer is `[N matches in M files; ...]`.
4. **Symbol extraction on `read_file`:**
   - With no offset/limit the result is raw content, exactly as before.
   - With either one, each line is `<line number right-aligned to width 6>\t<text>`, with an optional final `[lines A-B of T; use offset=N to continue]`.
   - Strip `/^\s*\d+\t/` and drop the `[lines ` line. The result is partial.
5. **`store.label()`:** fall back to `args.pattern` for `glob` and `grep`.
6. **Repeat detection:** it serializes all args, so reads at different offsets count as different calls. Keep it that way.
7. **Missing-file nudge:** `read_file` still throws the raw fs error, so `startsWith("Error: ENOENT")` still works. The other tools throw `ENOENT` too; the nudge could be extended to them.
8. **Note-taking nudge:** in the evals, it fired only during runs of `edit_file`. Consider not counting edit or grep steps as "silent".
9. **System prompt:** see `notes/prompt-additions-B.md`. It replaces the "prefer `git ls-files`" sentence.
10. **Tool order:** `[read_file, list_dir, glob, grep, edit_file, write_file, run_shell]`. `test/tools.test.ts` asserts this order.
11. **`truncate(s, max)`:** a `max` below the default now shrinks head and tail 3:1 to fit. Previously `write_file`'s `truncate(content, 500)` kept 6,000 + 2,000 chars, so mid-sized content appeared twice. Default-`max` output is byte-identical, and a test checks it.

## 2. Tool reference

All paths are relative to cwd. `\` is accepted on every platform; output always uses `/`. Every path goes through `resolveInCwd`, and every result through the agent's 10k head+tail `truncate`.

| Tool | Parameters (defaults) | Needs confirmation |
|---|---|---|
| `read_file` | `path`, `offset?` (1-based), `limit?` | no |
| `list_dir` | `path` (`.`), `depth` (2, range 1–5) | no |
| `glob` | `pattern`, `path` (`.`) | no |
| `grep` | `pattern` (JS regex), `path` (`.`, file or dir), `glob?`, `case_insensitive` (false), `context_lines` (0, range 0–5), `max_results` (100, range 1–500) | no |
| `edit_file` | `path`, `old_str`, `new_str`, `replace_all` (false) | yes, shows a compact diff |
| `write_file` | unchanged | yes |
| `run_shell` | unchanged | yes |

**Ignore rules:**
- Always skipped: `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`.
- `.gitignore` files are read at the root, between cwd and the requested path, and nested below it. Each file's rules are relative to its own directory; `!` re-includes.
- An explicitly requested ignored path is still walked.
- `.git/info/exclude` and global gitignore are not read.

**Links:** directory links and junctions are never descended into (`name/ (link, not followed)`). File links are searched only if their real path is inside cwd.

## 3. Output formats

- **`list_dir`:** depth-first, sorted case-insensitively: `src/`, `src/agent.ts (4.1 KB)`.
  - Sizes: `N B`, `N.N KB` or `N.N MB`.
  - Footers: `[N more entries omitted (limit 500); …]` and `[listing stopped after examining 50,000 entries]`. `(empty directory)` when empty.
- **`glob`:** files only, sorted, capped at 500.
  - No match: `No files match "<pattern>"`.
  - A pattern without `/` matches the file name at any depth.
  - Supports `* ** ? [a-z] [!x] {a,b}`. Case-insensitive on Windows only.
- **`grep`:** `path:line: text`, context lines `path-line- text`, and `--` between groups.
  - Footer: `[N matches in M files; …]`. Lines over 300 chars are clipped.
  - Binary files (a NUL byte in the first 8,000 bytes) and files over 1 MB are skipped.
  - A bad pattern throws `Invalid regex "<p>": <reason>`.
- **`edit_file`:**
  - Confirmation: `edit_file -> <path> (N replacement(s)[, CRLF line endings])` followed by `@@ line N @@` hunks.
  - Success: `Edited <path>: replaced 1 occurrence (lines 5-6)`, plus ` (matched after normalizing line endings to CRLF)` when the CRLF retry was used.
  - Errors: `old_str not found …` or `old_str occurs N times … (lines 3, 17) …`.
- **`read_file` with offset/limit:** `     3\tline 3`, with the footer `[lines 3-4 of 10; use offset=5 to continue]` when more lines follow.

## 4. Path restriction (P1 fix) and accepted limitations

**How `resolveInCwd` works now:**
- It converts `\` to `/`, then does the lexical check.
- It walks up with `lstat` to the deepest part of the path that exists and resolves it with `fs.realpathSync.native`, which follows symlinks and junctions and expands Windows short (8.3) names.
- The rest of the path is added back, and the result must lie inside `realpath(cwd)`.
- A dangling or looping link is refused.
- It returns the lexical path.

**Tests:** C4b and C5 are no longer `todo`. New C8–C11 cover every new tool refusing escapes, walks never following junctions, and dangling links being refused.

**Accepted limitations:**
- **Race window:** the path is checked before it is used, so a link swapped in between could escape.
- **grep ReDoS:** the regex runs synchronously with no timeout.
- **Backslashes on POSIX:** a file with a literal `\` in its name can't be addressed.
- **`run_shell`** is still not path-restricted, by design.

## 5. Dependencies

- **`ignore` ^7.0.10:** `.gitignore` parsing. It has no dependencies of its own and ships its own types.
- **No glob package:** Node's `path.matchesGlob` needs 20.17+ or 22.5+, and `fs.glob` needs 22+, while engines allows 20.12. `picomatch` would need `@types/picomatch` as a second package. Instead, `src/tools/globMatch.ts` (about 70 lines) converts a glob to a RegExp.
- **Regex search** uses the built-in `RegExp`.

## 6. Tests

`npm test` (branch alone): 102 tests: 101 pass, 0 todo, 1 skipped (C4, file symlinks need admin rights here).

`test/tools.test.ts` has 27 tests covering the registry order, `list_dir`, `glob`, `grep`, `edit_file` (including confirmation through `runAgent`), the `truncate` fix and `read_file` offset/limit.

## 7. Eval results (1 run each)

| Task | Result | Steps | Tokens | What happened |
|---|---|---|---|---|
| 13 find-call-sites | pass | 3 | 4,104 | 1 grep + write_file, 7 sites |
| 14 rename-function | pass | 5 | 8,628 | grep, 7 edit_file, `node check.js` |
| 15 large-file-edit | pass | 7 | 14,108 | grep with context, 3 ranged reads; the first `edit_file` got "occurs 2 times (lines 383, 384)" and was retried with context |
| 16 ignored-dir-search | pass | 3 | 3,800 | 1 grep, skipped the 1,200-file `node_modules` and the gitignored `generated/` |
| 05 find-string (sanity) | pass | 2 | 2,269 | 1 grep |

Every check was validated offline against an untouched fixture, a correct solution and a wrong one before these runs.
