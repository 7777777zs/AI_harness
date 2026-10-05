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
}

export function evalSettings(
  task: EvalTask,
  run: EvalRunSettings,
): SettingOverrides & { mcp: McpRunOptions; skills: { dirs: string[]; preload: string[] } } {
  const contextLimit = task.contextLimit ?? DEFAULTS.contextLimit;
  const compactModel = run.compactModel ?? run.mainModel;
  return {
    contextLimit,
    compactThreshold: task.compactThreshold ?? DEFAULTS.compactThreshold,
    recentBudget: Math.floor(contextLimit * DEFAULTS.recentBudgetFraction),
    coverageCheck: DEFAULTS.coverageCheck,
    coverageFooter: DEFAULTS.coverageFooter,
    maxSteps: task.maxSteps ?? DEFAULTS.maxSteps,
    prefinishMax: DEFAULTS.prefinishMax,
    ...(compactModel !== undefined && { compactModel }),
    mcp: { servers: task.mcpServers ?? {} },
    skillsEnabled: run.skills === "available" || run.skills === "preloaded" || run.skills === "routed",
    skillRouter: run.skills === "routed",
    skills: { dirs: [bundledSkillsDir()], preload: run.skills === "preloaded" && task.expectedSkill ? [task.expectedSkill] : [] },
  };
}
