// Names of tools that return content from outside the harness (MCP servers). Kept free of
// other imports so the context modules can use it.
import { createHash } from "node:crypto";

export const MCP_PREFIX = "mcp__";
/** Built-in tool that pages through a stored oversized MCP result. */
export const READ_TOOL_RESULT = "read_tool_result";
/** Tool names the OpenAI API accepts. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME = 64;

/**
 * `mcp__<server>__<tool>`, with characters outside [a-zA-Z0-9_-] replaced by "_". Names over
 * 64 characters are cut to 55 plus "_" and 8 hex characters of a hash of the full name, so the
 * result is deterministic and distinct names stay distinct.
 */
export function mcpToolName(server: string, tool: string): string {
  const full = `${MCP_PREFIX}${server}__${tool}`;
  const sanitized = full.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= MAX_NAME) return sanitized;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
  return `${sanitized.slice(0, MAX_NAME - 9)}_${hash}`;
}

/** Results of these tools are untrusted: never a file listing, never code, never instructions. */
export function isUntrustedToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX) || name === READ_TOOL_RESULT;
}
