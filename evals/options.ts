// Explicit harness settings for eval runs. Every setting is passed as a runAgent option, which
// has the highest precedence, so the user's environment and ~/.harness/.env cannot change eval
// behavior (A8). Only the model under test comes from OPENAI_MODEL. MCP servers are explicit too
// (none unless the task declares them), so ~/.harness/mcp.json is never read by evals. Skills
// come from the repo's skills/ only (never ~/.harness/skills/), and are on only in the
// "available" condition.
import { DEFAULTS, type SettingOverrides } from "../src/config.js";
import type { McpRunOptions } from "../src/mcp/config.js";
import { bundledSkillsDir } from "../src/skills/load.js";
import type { EvalTask } from "./types.js";

export interface TaskSelection {
  /** --task: one task by id, from any suite. */
  task?: string | undefined;
  /** --suite: "default" (every task outside the hard suite) or "hard" (only the hard suite). */
  suite?: string | undefined;
  withoutMcp?: boolean | undefined;
  withoutSkillTasks?: boolean | undefined;
}

/** The tasks a runner invocation runs, or why there are none. */
export function selectTasks(all: EvalTask[], opts: TaskSelection): { selected: EvalTask[]; error: string | null } {
  const suite = opts.suite ?? "default";
  if (suite !== "default" && suite !== "hard") return { selected: [], error: `--suite must be default or hard, got "${suite}"` };
  const requested = opts.task
    ? all.filter((t) => t.id === opts.task)
    : all.filter((t) => (suite === "hard") === (t.suite === "hard"));
  if (opts.task && requested.length === 0) {
    return { selected: [], error: `unknown task "${opts.task}". Available: ${all.map((t) => t.id).join(", ")}` };
  }
  const selected = requested
    .filter((t) => !(opts.withoutMcp && t.mcpServers))
    .filter((t) => !(opts.withoutSkillTasks && t.expectedSkill));
  if (opts.task && selected.length === 0) {
    // The requested task exists but a --without-* option removed it.
    const t = requested[0]!;
    const why = opts.withoutMcp && t.mcpServers
      ? "needs an MCP server, and --without-mcp skips it"
      : "is a with/without-skills task, and --without-skill-tasks skips it";
    return { selected: [], error: `task "${t.id}" ${why}` };
  }
  return { selected, error: null };
}

/**
 * A run's outcome for pass-rate accounting: runs that ended on API/infrastructure errors (after
 * retries) are "error", not "fail", and are excluded from pass rates.
 */
export function classifyOutcome(pass: boolean, errorKind: string | undefined): "pass" | "fail" | "error" {
  if (pass) return "pass";
  return errorKind === "api" ? "error" : "fail";
}

export interface EvalRunSettings {
  /** The model under test (OPENAI_MODEL); also the compaction model unless `compactModel` is set. */
  mainModel: string | undefined;
  /** Model for compaction calls (`--compact-model`); defaults to the main model. */
  compactModel?: string | undefined;
  /**
   * "off" (default): no skills. "available": the bundled skills are listed, none preloaded, so the
   * model has to decide. "preloaded": the task's expected skill is loaded before the first step
   * (measures what the skill's instructions do, independent of triggering). "routed": skills are
   * listed and the skill router picks one before the first step.
   */
  skills?: "off" | "available" | "preloaded" | "routed";
  /**
   * `--context-limit`: no task gets a larger context limit than this. For a server whose window is
   * smaller than the default (a local Ollama model), which truncates longer prompts silently.
   */
  contextLimitCap?: number;
  /** `--prefinish-max`: the pre-finish budget (default 2); local models narrate more and need more (I34). */
  prefinishMax?: number;
}

export function evalSettings(
  task: EvalTask,
  run: EvalRunSettings,
): SettingOverrides & { mcp: McpRunOptions; skills: { dirs: string[]; preload: string[] } } {
  const contextLimit = Math.min(task.contextLimit ?? DEFAULTS.contextLimit, run.contextLimitCap ?? Infinity);
  const compactModel = run.compactModel ?? run.mainModel;
  return {
    contextLimit,
    compactThreshold: task.compactThreshold ?? DEFAULTS.compactThreshold,
    recentBudget: Math.floor(contextLimit * DEFAULTS.recentBudgetFraction),
    coverageCheck: DEFAULTS.coverageCheck,
    coverageFooter: DEFAULTS.coverageFooter,
    maxSteps: task.maxSteps ?? DEFAULTS.maxSteps,
    prefinishMax: run.prefinishMax ?? DEFAULTS.prefinishMax,
    ...(compactModel !== undefined && { compactModel }),
    mcp: { servers: task.mcpServers ?? {} },
    skillsEnabled: run.skills === "available" || run.skills === "preloaded" || run.skills === "routed",
    skillRouter: run.skills === "routed",
    skills: { dirs: [bundledSkillsDir()], preload: run.skills === "preloaded" && task.expectedSkill ? [task.expectedSkill] : [] },
  };
}
