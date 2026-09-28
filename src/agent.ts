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
import { compact } from "./context/compact.js";
import { ContextTracker } from "./context/tokens.js";
import { makeSummarizer } from "./context/summarize.js";

export const MAX_STEPS = 20;

export interface RunAgentOptions {
  task: string;
  /** Sandbox directory: tool paths are restricted to it and shell commands run in it. */
  cwd: string;
  /** Skip the y/N confirmation for write_file and run_shell. Defaults to false. */
  autoApprove?: boolean;
  maxSteps?: number;
  /** Where the JSONL log goes. Defaults to <cwd>/logs. */
  logDir?: string;
  /** Context window budget in tokens. Defaults to env CONTEXT_LIMIT or 100000. */
  contextLimit?: number;
  /** Fraction of contextLimit that triggers compaction. Defaults to env COMPACT_THRESHOLD or 0.7. */
  compactThreshold?: number;
  /** Defaults to a client built from environment variables. */
  client?: LLMClient;
  /** Defaults to an interactive terminal y/N prompt. Ignored when autoApprove is true. */
  confirm?: (summary: string) => Promise<boolean>;
  tools?: Tool[];
  /** Suppress terminal output. */
  quiet?: boolean;
}

export interface AgentResult {
  finalText: string | null;
  steps: number;
  usage: Usage;
  stopReason: "done" | "max_steps" | "error";
  error?: string;
  durationMs: number;
  compactions: number;
  logFile: string;
}

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

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(opts.cwd);
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const contextLimit = opts.contextLimit ?? envNumber("CONTEXT_LIMIT", 100_000);
  const threshold = opts.compactThreshold ?? envNumber("COMPACT_THRESHOLD", 0.7);
  const tools = opts.tools ?? defaultTools;
  const out = opts.quiet ? () => {} : (s: string) => console.log(s);

  const logDir = opts.logDir ?? path.join(cwd, "logs");
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
    const summarize = makeSummarizer(client, addUsage);

    const maybeCompact = async (force: boolean) => {
      const r = await compact(messages, {
        currentTokens: tracker.estimate(messages, toolDefs),
        limit: contextLimit,
        threshold,
        summarize,
        force,
      });
      for (const ev of r.events) {
        out(c.magenta(`⟳ Compaction L${ev.level}: ~${fmt(ev.beforeTokens)} → ~${fmt(ev.afterTokens)} tokens (${ev.detail})`));
        log({ type: "compaction", step, contextLimit, threshold, ...ev });
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

      let response: LLMResponse;
      let sentCount = messages.length;
      try {
        response = await client.chat(messages, toolDefs);
      } catch (err) {
        if (!(err instanceof ContextLengthError)) throw err;
        out(c.red(`Context length exceeded; forcing compaction and retrying once.`));
        log({ type: "context_length_error", step, error: err.message });
        await maybeCompact(true);
        sentCount = messages.length;
        try {
          response = await client.chat(messages, toolDefs);
        } catch (retryErr) {
          if (retryErr instanceof ContextLengthError) {
            return finish("error", null, `Context length exceeded even after compaction: ${retryErr.message}`);
          }
          throw retryErr;
        }
      }

      addUsage(response.usage);
      tracker.record(response.usage.inputTokens, sentCount);
      log({ type: "step", step, request: { messages, tools: toolDefs }, response });

      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        out(c.green("\nFinal answer:\n") + (response.text ?? "(empty response)"));
        return finish("done", response.text);
      }

      if (response.text) out(c.cyan("Model: ") + response.text);

      for (const call of response.toolCalls) {
        const shownArgs = call.args ? JSON.stringify(call.args) : "(invalid JSON)";
        out(c.yellow(`→ ${call.name}`) + " " + c.dim(oneLine(shownArgs, 200)));

        const result = truncate(await executeTool(call, toolMap, ctx));
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });

        const color = result.startsWith("Error:") ? c.red : c.dim;
        out(color(`  ← ${oneLine(result, 150)} (${result.length} chars)`));
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
