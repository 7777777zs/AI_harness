---
name: codebase-onboarding
description: Map an unfamiliar codebase into an architecture overview. Use when asked to explain, summarize or onboard onto a project as a whole — its structure, modules, entry points, or how it works end to end.
readOnly: true
---

# Codebase onboarding

The goal is a **map**: after reading your overview, someone new to the project knows where things live and how a request moves through it. Read selectively — entry points and the main flow in full, everything else only far enough to name its role.

## Steps

1. **Map the structure.** `list_dir` at the root with depth 2–3. Note the top-level directories, manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Makefile`), test and docs directories. Done when you can guess a purpose for every top-level directory.
2. **Identify language, build and entry points.** Read the README and the manifest. Entry points: `main`/`bin`/`scripts` in `package.json`, `__main__.py`, `main.go`, `cmd/`, `src/index.*`, `src/main.*`, `app.*`. Done when you have named an entry point by path, or noted that none exists (a library).
3. **Read the entry points in full.** They show the wiring: what is created, registered and started, in what order. Write down what each one sets up, in the same message as your next tool call.
4. **Trace the main flow.** Pick the central operation (a request, a command, a job) and follow it hop by hop: `grep` for the names the entry point uses, then `read_file` each hop (offset/limit for large files). Watch for indirect wiring — event emitters, registries, dependency injection, middleware, callbacks — the flow is rarely a straight call chain. Done when you can write the flow as an ordered chain of `file → function` hops, from the entry point to the final effect (storage, response, output).
5. **Complete the module map.** For each module not yet read, skim its exports (`grep` for `export`, `def`, `class`) until you can state its responsibility in one line.
6. **Find how to run and test it**: manifest scripts, Makefile targets, CI config.
7. **Write the overview** in the format below. Every claim names a file.

## Output format

```
## Purpose
One or two sentences: what the project does and for whom.

## Module map
| Module (path) | Responsibility |

## Main flow
1. `path` — function: what happens
2. ...   (include indirect hops: "emits `x`; `other/path` listens and ...")

## Key files
- `path` — why it matters

## Run and test
Commands, and where they are defined.

## Open questions
What the code does not tell you.

## Coverage
Read in full: ... · Skimmed: ... · Not examined: ... (and why)
```

## Stop when

- The main flow is traced end to end and every top-level module has a one-line role. Breadth beats depth: every module at one line is better than three modules in detail.
- If the project is too large, cover the entry points and the main flow, and list what you skipped under **Coverage**.

## Don't

- Read every file in full — skim what is off the main flow.
- Describe a module you did not open; list it under *Not examined*.
- Change files. This skill is read-only: the harness disables `write_file`, `edit_file` and most of `run_shell` while it is loaded.
