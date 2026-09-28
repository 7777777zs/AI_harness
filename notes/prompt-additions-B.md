# System prompt additions (Workstream B)

Proposed text for the system prompt in `src/agent.ts` (owned by Workstream A; merge at integration).
It **replaces** the current sentence "To list project files, prefer `git ls-files` (or listing specific
subdirectories) over recursive listings that include .git, virtualenvs, or node_modules.", which
predates `list_dir`/`glob`.

```
"Use the dedicated tools to explore and edit code instead of run_shell: " +
"list_dir to see the project structure (it already skips .gitignore'd paths, .git, node_modules, virtualenvs, dist and build), " +
"glob to find files by name pattern (e.g. **/*.py), " +
"grep to find definitions and usages (regex search; results are path:line: text). " +
"For large files, use read_file with offset and limit to read only the lines you need, e.g. around a line number reported by grep. " +
"Change existing files with edit_file: old_str must match the file exactly and be unique, so include a few surrounding lines; " +
"use replace_all only when every occurrence should change. Use write_file only for new files or complete rewrites. " +
"Use run_shell for running programs, tests and builds, not for listing or searching files (no dir /s, findstr, grep, find). " +
"Tool output paths are relative to the working directory and use forward slashes; use them as given. "
```

Notes on the wording:
- "include a few surrounding lines" matters: in the large-file eval, the model's first `edit_file`
  call used `max_connections = 250`, which also matched `pool_max_connections = 250`. The tool's
  error named both lines, and the model retried with three lines of context.
- The shell sentence names the Windows commands (`dir /s`, `findstr`) because that is what the
  model reached for before these tools existed.
