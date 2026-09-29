// Main agent loop. Provider-agnostic: only uses the internal LLM types.
import fs from "node:fs";
import path from "node:path";
import { ContextLengthError, LLMApiError } from "./llm/types.js";
import { withRetry, type RetryOptions } from "./llm/retry.js";
import type { LLMClient, LLMResponse, Message, ToolCall, Usage } from "./llm/types.js";
import { createClientFromEnv } from "./llm/index.js";
import type { Tool, ToolContext } from "./types.js";
import { tools as defaultTools } from "./tools/index.js";
import { truncate } from "./tools/util.js";
import { createTerminalConfirm } from "./confirm.js";
import {
  ConfigError,
  DEFAULTS,
  describeConfig,
  envFileSources,
  harnessVersion,
  logsDir,
  resolveConfig,
  type HarnessConfig,
} from "./config.js";
import { capResult, capTurn, RESULT_CAP_FRACTION, shrinkNewest, TURN_CAP_FRACTION } from "./context/budget.js";
import { compact } from "./context/compact.js";
import { Coverage, isWholeProjectTask } from "./context/coverage.js";
import { ContextStore } from "./context/store.js";
import { ContextTracker, estimateTokens, estimateToolDefs } from "./context/tokens.js";
import { makeDescriber, makeSummarizer } from "./context/summarize.js";

export const MAX_STEPS = DEFAULTS.maxSteps;

export interface RunAgentOptions {
  task: string;
  /** Sandbox directory: tool paths are restricted to it and shell commands run in it. */
  cwd: string;
  /** Skip the y/N confirmation for write_file, edit_file and run_shell. Defaults to false. */
  autoApprove?: boolean;
  /** Where the JSONL log goes. Defaults to ~/.harness/logs (never inside cwd). */
  logDir?: string;
  // Settings below override env / ~/.harness/.env / defaults (see src/config.ts).
  maxSteps?: number;
  /** Context window budget in tokens (CONTEXT_LIMIT, default 100000). */
  contextLimit?: number;
  /** Fraction of contextLimit that triggers compaction (COMPACT_THRESHOLD, default 0.7). */
  compactThreshold?: number;
  /** Tokens of recent tool results kept in full by Level 1 (RECENT_BUDGET, default 40% of contextLimit). */
  recentBudget?: number;
  /** Model for compaction calls (COMPACT_MODEL, default: the main model). */
  compactModel?: string;
  /**
   * Before accepting a final answer to a whole-project task while listed files are unread,
   * ask the model once to read them or state what it skipped (COVERAGE_CHECK, default on).
   */
  coverageCheck?: boolean;
  /** Append the harness-computed coverage footer to the final answer (COVERAGE_FOOTER, default on). */
  coverageFooter?: boolean;
  /** Defaults to a client built from environment variables. */
  client?: LLMClient;
  /** Client for compaction calls. Defaults to a client for compactModel, else `client`. */
  compactClient?: LLMClient;
  /** Defaults to an interactive terminal y/N prompt. Ignored when autoApprove is true. */
  confirm?: (summary: string) => Promise<boolean>;
  tools?: Tool[];
  /** Suppress terminal output. */
  quiet?: boolean;
  /** Retry settings for transient API errors (tests inject sleep/random). */
  retry?: Omit<RetryOptions, "onRetry">;
}

export interface AgentResult {
  /** The final answer, with the harness coverage footer appended when files were left unread. */
  finalText: string | null;
  /** Every final-answer candidate the model produced (more than one after a coverage check). */
  answerHistory: string[];
  steps: number;
  /** Total tokens: main task + compaction. */
  usage: Usage;
  /** Tokens of the main task calls only. */
  mainUsage: Usage;
  stopReason: "done" | "max_steps" | "error";
  error?: string;
  /**
   * What kind of error ended the run: "api" for API/infrastructure failures (after retries),
   * "config" for invalid settings, "context_length" when compaction could not fit the request,
   * "other" for anything else.
   */
  errorKind?: "api" | "config" | "context_length" | "other";
  durationMs: number;
  /** Level 1 events plus accepted Level 2 events. */
  compactions: number;
  compactionStats: CompactionStats;
  /** Tool calls identical (same tool, same normalized args) to an earlier call in this run. */
  repeatedCalls: number;
  /** read_file calls that failed because the file does not exist. */
  missingFileReads: number;
  /** Hints the harness appended to tool results. */
  nudges: NudgeStats;
  /** Tokens spent on compaction calls (Level 1 descriptions + Level 2 summaries); included in `usage`. */
  compactionUsage: Usage & { calls: number };
  /** Harness-computed file coverage at the end of the run. */
  coverage: { known: number; read: number; unread: string[] };
  /** Calibrated ratio of actual to estimated tokens at the end of the run. */
  tokenRatio: number;
  /** Effective settings and where each came from; null if the configuration was invalid. */
  config: HarnessConfig | null;
  logFile: string;
}

export interface CompactionStats {
  level1: number;
  level2Accepted: number;
  level2Rejected: number;
  level2Skipped: number;
  describeFailures: number;
  /** Model-written descriptions dropped because they named something not in the original. */
  descriptionRejected: number;
}

export interface NudgeStats {
  notes: number;
  missingFile: number;
  repeat: number;
  /** Coverage check before accepting a final answer (at most once per run). */
  coverage: number;
}

export const coverageCheckMessage = (unread: string) =>
  `You have not read these files: ${unread}. Either read the relevant ones, or state in your final answer ` +
  "which files/directories you did not cover. Your next reply replaces your previous answer, so it must be " +
  "complete — include everything from your previous answer plus any additions.";

/** A final answer shorter than this share of the previous one is merged with it (A1 safety net). */
export const ANSWER_SHRINK_RATIO = 0.6;
export const ANSWER_MERGE_SEPARATOR = "\n\n--- (continued after the harness coverage check) ---\n\n";

/** Steps in a row with tool calls but no reply text before the note-taking reminder fires. */
export const SILENT_STEPS_BEFORE_NUDGE = 3;
/** Minimum steps between two note-taking reminders. */
export const NOTE_NUDGE_COOLDOWN = 3;

export const NOTE_NUDGE =
  "\n\nReminder: old tool results may be removed from context. Before continuing, write down key findings " +
  "from what you've read so far in your reply text.";
export const MISSING_FILE_HINT =
  "\n\nThis file does not exist. Don't guess paths; list the project files (e.g. git ls-files) and choose from the actual list.";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Identity of a tool call for repeat detection: tool name + arguments with sorted keys.
 * Paths are normalized the way the file tools resolve them (`./a.txt` = `sub/../a.txt` = `a.txt`,
 * case-insensitive on Windows); other strings, e.g. shell commands, are trimmed.
 */
export function callKey(call: ToolCall): string {
  if (!call.args) return `${call.name}:invalid:${call.argsError ?? ""}`;
  const normalized = Object.keys(call.args)
    .sort()
    .map((k) => {
      let v = call.args![k];
      if (typeof v === "string") {
        if (k === "path") {
          v = path.normalize(v);
          if (process.platform === "win32") v = (v as string).toLowerCase();
        } else {
          v = v.trim();
        }
      }
      return [k, v];
    });
  return `${call.name}:${JSON.stringify(normalized)}`;
}

/** Appended to a tool result from the 2nd identical call on. */
export function repeatNotice(call: ToolCall, count: number): string {
  const target = call.name === "run_shell" ? "with this command" : "on this path";
  return (
    `\n\nNote: you have called ${call.name} ${target} ${count} times. Its earlier result may have been removed to save context. ` +
    "Record key findings in your reply text as you go, and move the task forward rather than re-reading."
  );
}

/** A1 safety net: combine the final answer with the previous one if it shrank a lot. */
export function mergeAnswers(history: string[]): { text: string; merged: boolean } {
  const current = history.at(-1) ?? "";
  const previous = history.at(-2);
  if (previous !== undefined && current.length < ANSWER_SHRINK_RATIO * previous.length) {
    return { text: `${previous}${ANSWER_MERGE_SEPARATOR}${current}`, merged: true };
  }
  return { text: current, merged: false };
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(opts.cwd);
  const tools = opts.tools ?? defaultTools;
  const out = opts.quiet ? () => {} : (s: string) => console.log(s);

  const logDir = opts.logDir ?? logsDir();
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const log = (entry: object) =>
    fs.appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");

  const terminal = opts.autoApprove || opts.confirm ? undefined : createTerminalConfirm();
  const confirm: ToolContext["confirm"] = opts.autoApprove
    ? async (summary) => {
        out(c.magenta(`${summary}\n(auto-approved)`));
        return true;
      }
    : (opts.confirm ?? terminal!.confirm);
  const ctx: ToolContext = { cwd, confirm };

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (u: Usage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };
  const tracker = new ContextTracker();
  const store = new ContextStore();
  const stats: CompactionStats = {
    level1: 0,
    level2Accepted: 0,
    level2Rejected: 0,
    level2Skipped: 0,
    describeFailures: 0,
    descriptionRejected: 0,
  };
  const nudges: NudgeStats = { notes: 0, missingFile: 0, repeat: 0, coverage: 0 };
  const compactionUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const coverage = new Coverage(cwd);
  const answerHistory: string[] = [];
  let config: HarnessConfig | null = null;
  let coverageChecked = false;
  const callCounts = new Map<string, number>();
  let repeatedCalls = 0;
  let missingFileReads = 0;
  let silentSteps = 0;
  let lastNoteNudge = -Infinity;
  let compactions = 0;
  let step = 0;

  let messages: Message[] = [
    {
      role: "system",
      content:
        `You are a helpful coding agent working in the directory ${cwd} on ${process.platform}. ` +
        "Use the provided tools to inspect and change files or run commands. " +
        "All file paths must be relative to the working directory; paths outside it are rejected. " +
        "If a tool returns an error or the user denies an action, adapt your approach. " +
        "Use the dedicated tools instead of run_shell to explore and edit code: list_dir for the project structure " +
        "(it skips .gitignore'd paths, .git, node_modules, virtualenvs, dist and build), glob to find files by name " +
        "(e.g. **/*.py), grep to find definitions and usages (results are path:line: text), and read_file with offset " +
        "and limit for the relevant part of a large file. Change existing files with edit_file: old_str must match " +
        "exactly and be unique, so include a few surrounding lines. Use write_file only for new files or complete " +
        "rewrites, and run_shell for running programs, tests and builds, not for listing or searching files. " +
        "Tool output paths are relative to the working directory and use forward slashes. " +
        "When reading multiple files, briefly write down the key findings for each file in your reply text before moving on, " +
        "since old tool results may be removed from context. " +
        'A "[Harness status]" message lists the project files known from your listings and which ones you have not read yet; ' +
        "use it instead of listing the files again. " +
        "If you could not cover everything the task asked for (e.g. files or directories you did not read), " +
        "say so explicitly in your final answer and list what was skipped. " +
        "When the task is complete, reply with a concise final answer and no tool calls.",
    },
    { role: "user", content: opts.task },
  ];

  const finish = (
    stopReason: AgentResult["stopReason"],
    finalText: string | null,
    error?: string,
    errorKind?: AgentResult["errorKind"],
  ): AgentResult => {
    // A2: unread (or only partially read) known files are reported by the harness, not the model.
    const footer = stopReason === "done" && finalText !== null && config?.coverageFooter ? coverage.footer() : null;
    if (footer) finalText = `${finalText}\n\n${footer}`;
    const mainUsage = {
      inputTokens: usage.inputTokens - compactionUsage.inputTokens,
      outputTokens: usage.outputTokens - compactionUsage.outputTokens,
    };
    const result: AgentResult = {
      finalText,
      answerHistory,
      steps: step,
      usage,
      mainUsage,
      stopReason,
      ...(error !== undefined && { error, errorKind: errorKind ?? "other" }),
      durationMs: Date.now() - startedAt,
      compactions,
      compactionStats: stats,
      repeatedCalls,
      missingFileReads,
      nudges,
      compactionUsage,
      coverage: { known: coverage.known.size, read: coverage.known.size - coverage.unread().length, unread: coverage.unread() },
      tokenRatio: tracker.ratio,
      config,
      logFile,
    };
    log({ type: "result", ...result });
    if (stopReason !== "error") {
      if (footer) out(c.dim(footer));
      out(
        c.dim(
          `\nSteps: ${step} | main tokens in ${fmt(mainUsage.inputTokens)}, out ${fmt(mainUsage.outputTokens)} | ` +
            `compaction in ${fmt(compactionUsage.inputTokens)}, out ${fmt(compactionUsage.outputTokens)} (${compactionUsage.calls} calls) | ` +
            `token ratio ${tracker.ratio.toFixed(2)} | Log: ${logFile}`,
        ),
      );
    }
    return result;
  };

  try {
    // A8: validated settings with their sources (option > env > .env > default).
    try {
      config = resolveConfig({
        ...(opts.contextLimit !== undefined && { contextLimit: opts.contextLimit }),
        ...(opts.compactThreshold !== undefined && { compactThreshold: opts.compactThreshold }),
        ...(opts.recentBudget !== undefined && { recentBudget: opts.recentBudget }),
        ...(opts.compactModel !== undefined && { compactModel: opts.compactModel }),
        ...(opts.coverageCheck !== undefined && { coverageCheck: opts.coverageCheck }),
        ...(opts.coverageFooter !== undefined && { coverageFooter: opts.coverageFooter }),
        ...(opts.maxSteps !== undefined && { maxSteps: opts.maxSteps }),
      });
    } catch (err) {
      if (err instanceof ConfigError) return finish("error", null, `Invalid configuration: ${err.message}`, "config");
      throw err;
    }
    const { contextLimit, compactThreshold: threshold, recentBudget, maxSteps } = config;

    // Transient API errors (429, 5xx, connection) are retried with backoff for both clients.
    const retrying = (source: "main" | "compaction", inner: LLMClient) =>
      withRetry(inner, {
        ...opts.retry,
        onRetry: (info) => {
          out(c.yellow(`  ⟳ API ${info.status ?? "connection"} error (${source}); retry ${info.retry}/${info.maxRetries} in ${(info.delayMs / 1000).toFixed(1)}s`));
          log({ type: "api_retry", step, source, ...info });
        },
      });
    const rawClient = opts.client ?? createClientFromEnv();
    const client = retrying("main", rawClient);
    const mainModel = opts.client ? "(custom client)" : process.env.OPENAI_MODEL;
    const modelSource = opts.client ? "option" : envFileSources.has("OPENAI_MODEL") ? ".env" : "env";
    const separateCompactModel = config.compactModel !== undefined && config.compactModel !== process.env.OPENAI_MODEL;
    const compactClient = retrying(
      "compaction",
      opts.compactClient ?? (separateCompactModel && !opts.client ? createClientFromEnv(config.compactModel) : rawClient),
    );

    // A4: log the effective configuration once at the start.
    const version = harnessVersion();
    log({
      type: "run_start",
      model: mainModel,
      modelSource,
      compactModel: config.compactModel ?? mainModel,
      config,
      cwd,
      platform: process.platform,
      node: process.version,
      harness: version,
    });
    out(c.dim(`Config: model=${mainModel} (${modelSource}) ${describeConfig(config, mainModel)} | harness ${version.version}${version.commit ? ` @ ${version.commit}` : ""}`));

    // Compaction calls count toward total usage and are also tracked (and logged) separately.
    const compactionCall = (kind: "describe_call" | "level2_call") => (u: Usage) => {
      addUsage(u);
      compactionUsage.inputTokens += u.inputTokens;
      compactionUsage.outputTokens += u.outputTokens;
      compactionUsage.calls++;
      log({ type: kind, step, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    };
    const summarize = makeSummarizer(compactClient, compactionCall("level2_call"));
    const describe = makeDescriber(compactClient, compactionCall("describe_call"));
    const remainingWork = () =>
      coverage.known.size ? `Unread files (harness-computed): ${coverage.unreadText() || "none"}` : "";
    const resultCap = Math.floor(contextLimit * RESULT_CAP_FRACTION);
    const turnCap = Math.floor(contextLimit * TURN_CAP_FRACTION);
    const tokensOf = (text: string) => tracker.tokensOf(text);

    const maybeCompact = async (force: boolean) => {
      const r = await compact(messages, {
        currentTokens: tracker.estimate(messages, toolDefs),
        limit: contextLimit,
        threshold,
        recentBudget,
        summarize,
        describe,
        store,
        force,
        remainingWork,
        tokenScale: tracker.ratio,
      });
      if (r.describeError) {
        stats.describeFailures++;
        out(c.yellow(`⟳ Compaction: descriptions failed, using plain placeholders (${r.describeError})`));
        log({ type: "describe_failed", step, error: r.describeError });
      }
      for (const rej of r.rejectedDescriptions) {
        stats.descriptionRejected++;
        out(c.yellow(`⟳ Compaction: description rejected, it names "${rej.token}" which is not in the original`));
        log({ type: "description_rejected", step, ...rej });
      }
      for (const ev of r.events) {
        if (ev.level === 1) stats.level1++;
        else stats.level2Accepted++;
        out(c.magenta(`⟳ Compaction L${ev.level}: ~${fmt(ev.beforeTokens)} → ~${fmt(ev.afterTokens)} tokens (${ev.detail})`));
        log({ type: "compaction", step, contextLimit, threshold, recentBudget, tokenRatio: tracker.ratio, ...ev });
      }
      if (r.level2.status === "rejected" || r.level2.status === "skipped") {
        if (r.level2.status === "rejected") stats.level2Rejected++;
        else stats.level2Skipped++;
        out(c.yellow(`⟳ Compaction L2 ${r.level2.status}: ${r.level2.reason}`));
        log({ type: `level2_${r.level2.status}`, step, tokenRatio: tracker.ratio, ...r.level2 });
      }
      for (const note of r.notes) {
        out(c.yellow(`⟳ Compaction: ${note}`));
        log({ type: "compaction_note", step, note });
      }
      if (r.events.length > 0) {
        messages = r.messages;
        tracker.reset(r.tokens, messages.length);
        compactions += r.events.length;
      }
    };

    // The known-files status is attached to each request instead of stored in history,
    // so it is never elided or summarized and is always current.
    const withStatus = () => {
      const status = coverage.statusBlock(opts.task);
      return status ? [...messages, { role: "user" as const, content: status }] : messages;
    };

    // A3 preflight: never send a request estimated above the context limit.
    const preflight = () => {
      const status = coverage.statusBlock(opts.task);
      const estimate = tracker.estimate(messages, toolDefs) + (status ? tracker.tokensOf(status) : 0);
      if (estimate <= contextLimit) return;
      const shrunk = shrinkNewest(messages, estimate - contextLimit, tokensOf);
      if (shrunk.shrunk.length === 0) return;
      messages = shrunk.messages;
      for (const m of messages) {
        if (m.role === "tool" && shrunk.shrunk.includes(m.toolCallId)) {
          const orig = store.originals.get(m.toolCallId);
          if (orig) store.record(m.toolCallId, orig.name, orig.args, m.content);
        }
      }
      tracker.reset(Math.max(0, tracker.estimate(messages, toolDefs) - shrunk.saved), messages.length);
      out(c.yellow(`⟳ Preflight: request ~${fmt(estimate)} tokens > limit ${fmt(contextLimit)}; shrank ${shrunk.shrunk.length} newest result(s)`));
      log({ type: "preflight_truncated", step, estimate, limit: contextLimit, saved: shrunk.saved, shrunk: shrunk.shrunk });
    };

    while (step < maxSteps) {
      step++;
      out(c.bold(`\n── Step ${step} ──`));

      await maybeCompact(false);
      preflight();

      let request = withStatus();
      let response: LLMResponse;
      let sentCount = messages.length;
      try {
        response = await client.chat(request, toolDefs);
      } catch (err) {
        if (!(err instanceof ContextLengthError)) throw err;
        out(c.red(`Context length exceeded; forcing compaction and retrying once.`));
        log({ type: "context_length_error", step, error: err.message });
        await maybeCompact(true);
        preflight();
        sentCount = messages.length;
        request = withStatus();
        try {
          response = await client.chat(request, toolDefs);
        } catch (retryErr) {
          if (retryErr instanceof ContextLengthError) {
            return finish("error", null, `Context length exceeded even after compaction: ${retryErr.message}`, "context_length");
          }
          throw retryErr;
        }
      }

      addUsage(response.usage);
      // A5: calibrate the estimator against the API's actual count for this request.
      const heuristic = estimateTokens(request) + estimateToolDefs(toolDefs);
      const observedRatio = tracker.record(response.usage.inputTokens, sentCount, heuristic);
      log({
        type: "step",
        step,
        request: { messages: request, tools: toolDefs },
        response,
        heuristicTokens: heuristic,
        observedRatio,
        tokenRatio: tracker.ratio,
      });

      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        answerHistory.push(response.text ?? "");
        // Coverage check: once per run, don't accept a whole-project answer while listed files are unread.
        const unread = coverage.unread();
        if (config.coverageCheck && !coverageChecked && unread.length > 0 && isWholeProjectTask(opts.task)) {
          coverageChecked = true;
          nudges.coverage++;
          out(c.yellow(`  ⚑ coverage check: ${unread.length} listed file(s) not read; asking the model once more`));
          log({ type: "nudge", kind: "coverage", step, unread });
          messages.push({ role: "user", content: coverageCheckMessage(coverage.unreadText()) });
          continue;
        }
        // A1: the final reply must not silently drop an earlier, fuller answer.
        const merged = mergeAnswers(answerHistory);
        if (merged.merged) {
          out(c.yellow(`  ⚑ final answer much shorter than the previous one; keeping both`));
          log({
            type: "answer_merged",
            step,
            previousChars: answerHistory.at(-2)!.length,
            currentChars: answerHistory.at(-1)!.length,
          });
        }
        out(c.green("\nFinal answer:\n") + (merged.text || "(empty response)"));
        return finish("done", response.text === null && !merged.merged ? null : merged.text);
      }

      if (response.text) out(c.cyan("Model: ") + response.text);

      // Execute every call of this turn, then apply the size caps, then append harness hints.
      const turn: { call: ToolCall; content: string; hints: string }[] = [];
      for (const call of response.toolCalls) {
        const shownArgs = call.args ? JSON.stringify(call.args) : "(invalid JSON)";
        out(c.yellow(`→ ${call.name}`) + " " + c.dim(oneLine(shownArgs, 200)));

        const key = callKey(call);
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);

        const raw = await executeTool(call, toolMap, ctx);
        // Coverage uses the full output (a truncated listing would lose paths).
        if (!raw.startsWith("Error:")) {
          coverage.addListing(call.name, call.args, raw);
          if (call.name === "read_file" && typeof call.args?.path === "string") {
            coverage.markRead(call.args.path, call.args.offset !== undefined || call.args.limit !== undefined);
          }
        }
        // A3 per-result cap: no single result above RESULT_CAP_FRACTION of the context limit.
        let content = truncate(raw);
        if (tokensOf(content) > resultCap) {
          const before = tokensOf(content);
          content = capResult(call.name, call.args, call.name === "read_file" ? raw : content, resultCap, tokensOf);
          log({ type: "result_capped", step, tool: call.name, beforeTokens: before, afterTokens: tokensOf(content), cap: resultCap });
        }

        let hints = "";
        if (call.name === "read_file" && raw.startsWith("Error: ENOENT")) {
          missingFileReads++;
          nudges.missingFile++;
          hints += MISSING_FILE_HINT;
          log({ type: "nudge", kind: "missing_file", step, args: call.args });
        }
        if (count >= 2) {
          repeatedCalls++;
          nudges.repeat++;
          hints += repeatNotice(call, count);
          log({ type: "repeated_call", step, tool: call.name, args: call.args, count });
          log({ type: "nudge", kind: "repeat", step, tool: call.name, count });
        }
        turn.push({ call, content, hints });
      }

      // A3 per-turn cap: all results of this turn together within TURN_CAP_FRACTION of the limit.
      const totalTurn = turn.reduce((s, t) => s + tokensOf(t.content), 0);
      if (totalTurn > turnCap) {
        const capped = capTurn(
          turn.map((t) => ({ name: t.call.name, args: t.call.args, content: t.content })),
          turnCap,
          tokensOf,
        );
        capped.forEach((content, i) => (turn[i]!.content = content));
        const after = capped.reduce((s, x) => s + tokensOf(x), 0);
        out(c.yellow(`⟳ Turn cap: ${turn.length} results ~${fmt(totalTurn)} tokens > ${fmt(turnCap)}; shrank to ~${fmt(after)}`));
        log({ type: "turn_capped", step, beforeTokens: totalTurn, afterTokens: after, cap: turnCap });
      }

      for (const { call, content, hints } of turn) {
        // The store keeps the result as the model sees it, without harness hints.
        store.record(call.id, call.name, call.args, content);
        const result = content + hints;
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
        const color = result.startsWith("Error:") ? c.red : c.dim;
        out(color(`  ← ${oneLine(result, 150)} (${result.length} chars)`));
      }

      // Note-taking nudge: tool calls with no reply text for several steps in a row.
      silentSteps = response.text?.trim() ? 0 : silentSteps + 1;
      if (silentSteps >= SILENT_STEPS_BEFORE_NUDGE && step - lastNoteNudge >= NOTE_NUDGE_COOLDOWN) {
        const last = messages.at(-1)!;
        if (last.role === "tool") {
          messages[messages.length - 1] = { ...last, content: last.content + NOTE_NUDGE };
          lastNoteNudge = step;
          nudges.notes++;
          out(c.yellow(`  ⚑ note-taking reminder (${silentSteps} silent steps)`));
          log({ type: "nudge", kind: "notes", step, silentSteps });
        }
      }
    }

    out(c.red(`\nStopped: reached MAX_STEPS (${maxSteps}) without a final answer.`));
    return finish("max_steps", null);
  } catch (err) {
    return finish("error", null, err instanceof Error ? err.message : String(err), err instanceof LLMApiError ? "api" : "other");
  } finally {
    terminal?.close();
  }
}

async function executeTool(call: ToolCall, toolMap: Map<string, Tool>, ctx: ToolContext): Promise<string> {
  const tool = toolMap.get(call.name);
  if (!tool) return `Error: Unknown tool "${call.name}"`;
  if (call.argsError || !call.args) return `Error: Invalid JSON arguments: ${call.argsError ?? "missing"}`;
  try {
    return await tool.execute(call.args, ctx);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
