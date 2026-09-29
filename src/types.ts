import type { ToolDefinition } from "./llm/types.js";

export interface ToolContext {
  /** Directory all file paths are restricted to. */
  cwd: string;
  /** Show `summary` to the user and resolve true only if they approve. */
  confirm(summary: string): Promise<boolean>;
}

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Where the tool comes from, for tools provided by an MCP server. */
  source?: { kind: "mcp"; server: string; tool: string };
  /** Its results come from outside the harness (e.g. web pages): data, never instructions. */
  untrusted?: boolean;
}

export const DENIED = "User denied this action";
