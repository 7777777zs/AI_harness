# Local Qwen through Ollama: Implementation Plan

**Goal:** Run the harness with a local Qwen3 model served by Ollama: interactively from the CLI, and through the eval runner so it can be compared with gpt-4.1-mini on the same tasks.

**Approach:** configuration first. Ollama serves an OpenAI-compatible API at `http://127.0.0.1:11434/v1`, and the harness's OpenAI SDK already reads `OPENAI_BASE_URL`, so no provider code is needed to connect. Code is added only where verification shows it is needed, test-first (`/tdd`), in `src/llm/` or `evals/`.

**Decisions (2026-10-13):** both models (14b default, 8b compared); CLI and evals; configuration first; a Modelfile variant with a 32k context; thinking on vs off decided by measurement; upgrade Ollama first; commands that reach Ollama run with the sandbox disabled, one approval each; verification = smoke test + the 19 core tasks once + a thinking on/off comparison.

**Budget:** no API spending (local model). Time: the core suite on a local 14b model takes far longer than on the API.

## Facts (2026-10-13)

| Item | Value |
|---|---|
| Ollama | 0.32.1 installed; 0.40.3 downloaded, waiting to be installed |
| Models | `qwen3:14b` (14.8B, Q4_K_M, 8.6 GB), `qwen3:8b` (8.2B, Q4_K_M, 4.9 GB); both templates support tools and thinking |
| GPU | AMD Radeon RX 7900 XTX, 24 GB VRAM (Windows reports 4 GB through a 32-bit field) |
| CPU / RAM | Ryzen 5 5600 (6 cores, 12 threads), 16 GB RAM (2.2 GB free when checked) |
| Fit | 14b at 32k context: ~9 GB weights + ~5 GB KV cache (≈160 KB/token, f16) ≈ 14–15 GB, fully on the GPU; 8b ≈ 10 GB |
| Unverified | whether Ollama uses the GPU (no detection line in `server.log` yet); the default context window of the OpenAI-compatible endpoint; how thinking text is returned there |

**Two pitfalls this plan exists for:**
1. **Silent truncation.** The OpenAI-compatible endpoint cannot set the context window per request, and Ollama truncates an over-long prompt (from the front) instead of returning an error. The harness then never sees a context-length error, and the system prompt or task can disappear. The server's window and the harness's `CONTEXT_LIMIT` must match, with the harness at or below the server.
2. **Evals bypass the environment.** `evals/options.ts` passes `contextLimit: task.contextLimit ?? 100000` explicitly, and the eval runner deliberately ignores `CONTEXT_LIMIT`. Against a 32k server, every task without its own limit would be truncated silently.

## Tasks

### Task 0: Upgrade Ollama (user)
- Use "Restart to update" in the Ollama tray menu. Then check `ollama --version` reports 0.40.3 or later.

### Task 1: Confirm the GPU is used
- Load `qwen3:14b` once (`ollama run qwen3:14b "hi"`), then `ollama ps`: the PROCESSOR column must say `100% GPU`.
- Check `%LOCALAPPDATA%\Ollama\server.log` for the GPU detection line (library ROCm or Vulkan, the 7900 XTX, ~24 GB).
- If the model runs on the CPU, stop and diagnose before anything else (`/diagnosing-bugs`); every later measurement depends on it.

### Task 2: 32k Modelfile variants
- `qwen3-14b-32k`: `FROM qwen3:14b` + `PARAMETER num_ctx 32768`; same for `qwen3-8b-32k`. Create with `ollama create`.
- Check `ollama show qwen3-14b-32k --parameters` shows `num_ctx 32768`, and `ollama ps` after a request shows the model at ~14–15 GB and `100% GPU`.

### Task 3: Configuration-only connection
Per shell session, without touching the API configuration in `.env` (environment variables win over `.env`):

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:11434/v1"
$env:OPENAI_API_KEY = "ollama"        # any non-empty value; Ollama ignores it
$env:OPENAI_MODEL = "qwen3-14b-32k"
$env:CONTEXT_LIMIT = "30000"          # below num_ctx 32768: room for the reply and estimate error
```

`COMPACT_MODEL` stays unset, so compaction uses the same local model.

### Task 4: Smoke test and protocol checks (CLI)
In a scratch directory with a small file:
1. A task that needs one `read_file` call: the tool call is made, the answer is right, `usage` is reported (the terminal shows main tokens and a token ratio).
2. Record from the run log: whether thinking text arrives inside `content` (e.g. `<think>…</think>`), in a separate field, or not at all; the latency per step.
3. **Truncation probe:** send one request longer than `num_ctx` and observe what comes back (error or silent truncation). This decides whether the harness needs a startup check.

### Task 5: Code, only what Tasks 1–4 showed is needed (TDD)
Expected:
- **Eval runner `--context-limit N`** (needed, pitfall 2): caps every task's context limit at N (`min(task limit, N)`), recorded in the results file like the other settings. Seam: `evalSettings` plus a runner child-process test.
- **Thinking text in `content`** (only if Task 4 shows it): strip `<think>…</think>` from the final answer and from what is kept in history, in the OpenAI adapter, so it does not reach coverage, completion checks or compaction. Seam: the adapter with a stubbed `fetch`.
- **Context check at startup** (only if the probe shows silent truncation): when `OPENAI_BASE_URL` points to Ollama, read the model's `num_ctx` from `/api/show` and fail with a clear message if `CONTEXT_LIMIT` exceeds it. Seam: the CLI against a fake server.

### Task 6: Thinking on vs off
- Find how thinking is turned off on Ollama 0.40.x through the OpenAI-compatible endpoint (a request option, a Modelfile variant, or `/no_think` in the prompt); prefer a way that needs no harness code.
- Run the same 5 core tasks (create-file, fix-bug, find-string, multi-file-summary, rename-function) with `qwen3-14b-32k`, thinking on and off. Compare pass, steps, tokens and wall time. Pick the default.

### Task 7: Core suite comparison
- `npm run eval -- --without-mcp --without-skill-tasks --context-limit 30000 --concurrency 1` with `qwen3-14b-32k` (chosen thinking setting) and with `qwen3-8b-32k`.
- Compare with the latest gpt-4.1-mini core run (`2026-10-07T08-13-51-926Z`, 18/19). The gpt-4.1-mini run used larger context limits for some tasks, so note which tasks were capped.
- Per model: pass rate, failure reasons, steps, tokens, wall time.

### Task 8: Documentation
- README: a "Local models (Ollama)" section: the variables of Task 3, the Modelfile, `--context-limit`, and the truncation pitfall.
- TEST_REPORT.md: the measurements of Tasks 1, 4, 6 and 7.
- ISSUES.md: anything found but not fixed (e.g. web tasks with a local model, which are not part of this round).

## Done when
- The CLI runs a tool-using task on `qwen3-14b-32k`, fully on the GPU.
- The eval runner can cap the context limit, and the core suite has results for both models next to gpt-4.1-mini.
- Every code change came with a failing test first, `npm test` and `tsc` pass, and the change was reviewed with `/code-review` before merging.

## Outcome (2026-10-13)

- **Tasks 0–4:** Ollama 0.40.3 runs both models fully on the GPU (ROCm, gfx1100), with a 32k context. The configuration-only connection works. Thinking arrives in a separate `reasoning` field, so no stripping was needed. The truncation probe confirmed pitfall 1: 42,055 prompt tokens became 16,386, the system prompt was dropped, and the server returned HTTP 200.
- **Task 5:** eval runner `--context-limit` (`e24e3a4`); startup check of the server's num_ctx through `LLMClient.contextWindow()` (`5e43082`).
- **Task 6:** the only working switch for thinking is `reasoning_effort: "none"`, so `OPENAI_REASONING_EFFORT` was added (`e81f14e`). Off was about 20× faster with no measurable quality loss on 5 tasks, so it was used for the core suite.
- **Task 7:** core suite 8/19 (14b) and 10/19 (8b) against 18/19 for gpt-4.1-mini. A third of the local failures were I33, which was fixed (`a0d2e1f`): 10/19 and 12/19 afterwards, and gpt-4.1-mini unaffected (17/19; its change is count-lines). Open: I34.
- **Task 8:** README "Local models (Ollama)", TEST_REPORT.md "Local Qwen3 through Ollama", ISSUES.md I34, RESOLVED.md I33.
