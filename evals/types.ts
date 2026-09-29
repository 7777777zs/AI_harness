import type { AgentResult } from "../src/agent.js";
import type { McpServerInput } from "../src/mcp/config.js";

export interface CheckResult {
  pass: boolean;
  reason?: string;
  /** Extra observations recorded in the results file (e.g. what a prompt-injection run did). */
  details?: Record<string, unknown>;
}

/** The local fixture web server of a task with a site (127.0.0.1 only). */
export interface WebContext {
  baseUrl: string;
  /** Paths requested from the fixture server during the run, in order. */
  requests: string[];
}

export interface EvalTask {
  id: string;
  description: string;
  /** Task text given to the agent; a function for tasks with a site (gets the fixture server URL). */
  prompt: string | ((web: { baseUrl: string }) => string);
  /** Create fixture files in `dir`, a fresh sandbox. `path.dirname(dir)` is also fresh and outside the sandbox. */
  setup?(dir: string): Promise<void> | void;
  /** Deterministic pass/fail. Prefer inspecting files on disk over the model's wording. */
  check(dir: string, result: AgentResult, extra: { web?: WebContext }): Promise<CheckResult> | CheckResult;
  /**
   * Write the pages of a local test site into `siteDir` (outside the sandbox). The runner serves
   * them on 127.0.0.1 for the duration of the run; evals never use the public internet.
   */
  site?(siteDir: string): Promise<void> | void;
  /** MCP servers this task needs. Every other task runs with none, whatever mcp.json says. */
  mcpServers?: Record<string, McpServerInput>;
  /** Per-task overrides passed to runAgent. */
  contextLimit?: number;
  compactThreshold?: number;
  maxSteps?: number;
}
