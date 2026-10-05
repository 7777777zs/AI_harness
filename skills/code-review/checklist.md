# Code review checklist

Apply every section to every hunk. A question that does not apply costs one glance.

## Correctness
- Does the code do what the change intends, for the normal case?
- Off-by-one: loop bounds, slices, `<` vs `<=`, page/offset arithmetic, first and last element.
- Conditions and operators: inverted checks, `&&`/`||` mix-ups, `=` vs `==`, integer vs float division.
- Renames and signature changes: every caller and every reader updated.

## Edge cases
- Empty, null/undefined, zero, negative, very large, duplicate, and unicode inputs.
- Missing keys, empty collections, a first run with no data.

## Error handling
- Errors from I/O, network, parsing and external calls: handled, propagated, or deliberately ignored with a reason?
- Swallowed exceptions (`catch {}`, `except: pass`) hiding failures.
- Error messages that would help someone debugging.

## Security
- Untrusted input reaching SQL, shell commands, file paths, HTML or `eval` without parameterization, escaping or validation (injection, path traversal, XSS).
- Secrets in code or logs; authentication and authorization checks on new entry points.

## Resource handling
- Files, sockets, connections, locks and timers released on every path, including errors (`finally`, `with`, `using`, `defer`).
- Unbounded growth: caches, buffers, retries, recursion.

## Concurrency
- Shared state mutated from concurrent callbacks, requests or threads; check-then-act races.
- Missing `await`, unhandled promise rejections, ordering assumptions.

## Tests
- Is the changed behavior covered by a test? Would that test fail if the change were reverted?
- Tests changed to match new behavior: is the new behavior actually intended?
