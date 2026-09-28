import type { AgentResult } from "../src/agent.js";

export interface CheckResult {
  pass: boolean;
  reason?: string;
}

export interface EvalTask {
  id: string;
  description: string;
  /** Task text given to the agent. */
  prompt: string;
  /** Create fixture files in `dir`, a fresh sandbox. `path.dirname(dir)` is also fresh and outside the sandbox. */
  setup?(dir: string): Promise<void> | void;
  /** Deterministic pass/fail. Prefer inspecting files on disk over the model's wording. */
  check(dir: string, result: AgentResult): Promise<CheckResult> | CheckResult;
  /** Per-task overrides passed to runAgent. */
  contextLimit?: number;
  compactThreshold?: number;
  maxSteps?: number;
}
