// Explicit harness settings for eval runs. Every setting is passed as a runAgent option, which
// has the highest precedence, so the user's environment and ~/.harness/.env cannot change eval
// behavior (A8). Only the model under test comes from OPENAI_MODEL.
import { DEFAULTS, type SettingOverrides } from "../src/config.js";
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
}

export function evalSettings(task: EvalTask, run: EvalRunSettings): SettingOverrides {
  const contextLimit = task.contextLimit ?? DEFAULTS.contextLimit;
  const compactModel = run.compactModel ?? run.mainModel;
  return {
    contextLimit,
    compactThreshold: task.compactThreshold ?? DEFAULTS.compactThreshold,
    recentBudget: Math.floor(contextLimit * DEFAULTS.recentBudgetFraction),
    coverageCheck: DEFAULTS.coverageCheck,
    coverageFooter: DEFAULTS.coverageFooter,
    maxSteps: task.maxSteps ?? DEFAULTS.maxSteps,
    ...(compactModel !== undefined && { compactModel }),
  };
}
