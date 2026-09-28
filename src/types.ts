import type { ToolDefinition } from "./llm/types.js";

export interface ToolContext {
  /** Directory all file paths are restricted to. */
  cwd: string;
  /** Show `summary` to the user and resolve true only if they approve. */
  confirm(summary: string): Promise<boolean>;
}

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const DENIED = "User denied this action";
