// Main agent loop. Provider-agnostic: only uses the internal LLM types.
import fs from "node:fs";
import path from "node:path";
import { ContextLengthError } from "./llm/types.js";
import type { LLMClient, LLMResponse, Message, ToolCall, Usage } from "./llm/types.js";
import { createClientFromEnv } from "./llm/index.js";
import type { Tool, ToolContext } from "./types.js";
import { tools as defaultTools } from "./tools/index.js";
import { truncate } from "./tools/util.js";
import { createTerminalConfirm } from "./confirm.js";
import { logsDir } from "./config.js";
import { compact, RECENT_BUDGET_FRACTION } from "./context/compact.js";
import { Coverage, isWholeProjectTask } from "./context/coverage.js";
import { ContextStore } from "./context/store.js";
import { ContextTracker } from "./context/tokens.js";
import { makeDescriber, makeSummarizer } from "./context/summarize.js";

export const MAX_STEPS = 20;

export interface RunAgentOptions {
  task: string;
  /** Sandbox directory: tool paths are restricted to it and shell commands run in it. */
  cwd: string;
  /** Skip the y/N confirmation for write_file and run_shell. Defaults to false. */
  autoApprove?: boolean;
  maxSteps?: number;
  /** Where the JSONL log goes. Defaults to ~/.harness/logs (never inside cwd). */
  logDir?: string;
  /** Context window budget in tokens. Defaults to env CONTEXT_LIMIT or 100000. */
  contextLimit?: number;
  /** Fraction of contextLimit that triggers compaction. Defaults to env COMPACT_THRESHOLD or 0.7. */
  compactThreshold?: number;
  /** Tokens of recent tool results kept in full by Level 1. Defaults to env RECENT_BUDGET or 40% of contextLimit. */
  recentBudget?: number;
  /** Defaults to a client built from environment variables. */
  client?: LLMClient;
  /** Defaults to an interactive terminal y/N prompt. Ignored when autoApprove is true. */
  confirm?: (summary: string) => Promise<boolean>;
  tools?: Tool[];
  /** Suppress terminal output. */
  quiet?: boolean;
  /**
   * Before accepting a final answer to a whole-project task while listed files are unread,
   * ask the model once to read them or state what it skipped. Defaults to env COVERAGE_CHECK
   * ("on" unless set to "off").
   */
  coverageCheck?: boolean;
}

export interface AgentResult {
  finalText: string | null;
  steps: number;
  usage: Usage;
  stopReason: "done" | "max_steps" | "error";
  error?: string;
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
  "which files/directories you did not cover.";

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

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value > 0 ? value : fallback;
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

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(opts.cwd);
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const contextLimit = opts.contextLimit ?? envNumber("CONTEXT_LIMIT", 100_000);
  const threshold = opts.compactThreshold ?? envNumber("COMPACT_THRESHOLD", 0.7);
  const recentBudget = opts.recentBudget ?? envNumber("RECENT_BUDGET", contextLimit * RECENT_BUDGET_FRACTION);
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
  const coverageCheck = opts.coverageCheck ?? process.env.COVERAGE_CHECK?.toLowerCase() !== "off";
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
        "When reading multiple files, briefly write down the key findings for each file in your reply text before moving on, " +
        "since old tool results may be removed from context. " +
        "To list project files, prefer `git ls-files` (or listing specific subdirectories) over recursive listings " +
        "that include .git, virtualenvs, or node_modules. " +
        "If you could not cover everything the task asked for (e.g. files or directories you did not read), " +
        "say so explicitly in your final answer and list what was skipped. " +
        "When the task is complete, reply with a concise final answer and no tool calls.",
    },
    { role: "user", content: opts.task },
  ];

  const finish = (stopReason: AgentResult["stopReason"], finalText: string | null, error?: string): AgentResult => {
    const result: AgentResult = {
      finalText,
      steps: step,
      usage,
      stopReason,
      ...(error !== undefined && { error }),
      durationMs: Date.now() - startedAt,
      compactions,
      compactionStats: stats,
      repeatedCalls,
      missingFileReads,
      nudges,
      compactionUsage,
      coverage: { known: coverage.known.size, read: coverage.known.size - coverage.unread().length, unread: coverage.unread() },
      logFile,
    };
    log({ type: "result", ...result });
    if (stopReason !== "error") {
      out(c.dim(`\nSteps: ${step} | Tokens in: ${usage.inputTokens}, out: ${usage.outputTokens} | Log: ${logFile}`));
    }
    return result;
  };

  try {
    const client = opts.client ?? createClientFromEnv();
    // Compaction calls count toward total usage and are also tracked (and logged) separately.
    const compactionCall = (kind: "describe_call" | "level2_call") => (u: Usage) => {
      addUsage(u);
      compactionUsage.inputTokens += u.inputTokens;
      compactionUsage.outputTokens += u.outputTokens;
      compactionUsage.calls++;
      log({ type: kind, step, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    };
    const summarize = makeSummarizer(client, compactionCall("level2_call"));
    const describe = makeDescriber(client, compactionCall("describe_call"));
    const remainingWork = () =>
      coverage.known.size ? `Unread files (harness-computed): ${coverage.unreadText() || "none"}` : "";

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
        log({ type: "compaction", step, contextLimit, threshold, recentBudget, ...ev });
      }
      if (r.level2.status === "rejected" || r.level2.status === "skipped") {
        if (r.level2.status === "rejected") stats.level2Rejected++;
        else stats.level2Skipped++;
        out(c.yellow(`⟳ Compaction L2 ${r.level2.status}: ${r.level2.reason}`));
        log({ type: `level2_${r.level2.status}`, step, ...r.level2 });
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

    while (step < maxSteps) {
      step++;
      out(c.bold(`\n── Step ${step} ──`));

      await maybeCompact(false);

      // The known-files status is attached to each request instead of stored in history,
      // so it is never elided or summarized and is always current.
      const withStatus = () => {
        const status = coverage.statusBlock(opts.task);
        return status ? [...messages, { role: "user" as const, content: status }] : messages;
      };
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
        sentCount = messages.length;
        request = withStatus();
        try {
          response = await client.chat(request, toolDefs);
        } catch (retryErr) {
          if (retryErr instanceof ContextLengthError) {
            return finish("error", null, `Context length exceeded even after compaction: ${retryErr.message}`);
          }
          throw retryErr;
        }
      }

      addUsage(response.usage);
      tracker.record(response.usage.inputTokens, sentCount);
      log({ type: "step", step, request: { messages: request, tools: toolDefs }, response });

      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        // Coverage check: once per run, don't accept a whole-project answer while listed files are unread.
        const unread = coverage.unread();
        if (coverageCheck && !coverageChecked && unread.length > 0 && isWholeProjectTask(opts.task)) {
          coverageChecked = true;
          nudges.coverage++;
          out(c.yellow(`  ⚑ coverage check: ${unread.length} listed file(s) not read; asking the model once more`));
          log({ type: "nudge", kind: "coverage", step, unread });
          messages.push({ role: "user", content: coverageCheckMessage(coverage.unreadText()) });
          continue;
        }
        out(c.green("\nFinal answer:\n") + (response.text ?? "(empty response)"));
        return finish("done", response.text);
      }

      if (response.text) out(c.cyan("Model: ") + response.text);

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
        let result = truncate(raw);
        // The store keeps the result without harness hints, for descriptions and summaries.
        store.record(call.id, call.name, call.args, result);
        // Hints are appended after truncation so they are never cut off.
        if (call.name === "read_file" && result.startsWith("Error: ENOENT")) {
          missingFileReads++;
          nudges.missingFile++;
          result += MISSING_FILE_HINT;
          log({ type: "nudge", kind: "missing_file", step, args: call.args });
        }
        if (count >= 2) {
          repeatedCalls++;
          nudges.repeat++;
          result += repeatNotice(call, count);
          log({ type: "repeated_call", step, tool: call.name, args: call.args, count });
          log({ type: "nudge", kind: "repeat", step, tool: call.name, count });
        }
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
    return finish("error", null, err instanceof Error ? err.message : String(err));
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
