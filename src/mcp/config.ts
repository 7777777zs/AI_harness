// MCP server configuration: ~/.harness/mcp.json in the common `{ "mcpServers": { ... } }`
// format plus harness-specific fields, validated with the same error style as the .env settings.
import fs from "node:fs";
import path from "node:path";
import { ConfigError, harnessHome } from "../config.js";

/** One server as written in mcp.json (or passed as a runAgent option). */
export interface McpServerInput {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Only "stdio" is supported. */
  type?: "stdio";
  /** Default true. */
  enabled?: boolean;
  /** Only these tools are exposed to the model (default: all). */
  includeTools?: string[];
  /** These tools are never exposed. */
  excludeTools?: string[];
  /** Tools that run without user confirmation. Every other MCP tool asks first. */
  autoApproveTools?: string[];
  /** Parameters removed from a tool's schema and rejected in calls, e.g. { "take_snapshot": ["filePath"] }. */
  hideParams?: Record<string, string[]>;
  /** Per tool call; default 60000. */
  callTimeoutMs?: number;
  /** Process start + MCP handshake + tool listing; default 30000. */
  startupTimeoutMs?: number;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  includeTools: string[] | undefined;
  excludeTools: string[];
  autoApproveTools: string[];
  hideParams: Record<string, string[]>;
  callTimeoutMs: number;
  startupTimeoutMs: number;
}

/** MCP settings for one run. */
export interface McpRunOptions {
  /** Servers to use instead of reading ~/.harness/mcp.json (the eval runner always sets this). */
  servers?: Record<string, McpServerInput>;
  /** Only these servers (`--mcp a,b`); a named server runs even if it has `enabled: false`. */
  only?: string[];
  /** No MCP servers at all (`--no-mcp`). */
  disabled?: boolean;
}

export const MCP_DEFAULTS = { callTimeoutMs: 60_000, startupTimeoutMs: 30_000 } as const;
const TIMEOUT_RANGE = [1_000, 600_000] as const;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const KNOWN_KEYS = new Set([
  "command",
  "args",
  "env",
  "type",
  "enabled",
  "includeTools",
  "excludeTools",
  "autoApproveTools",
  "hideParams",
  "callTimeoutMs",
  "startupTimeoutMs",
]);

export function mcpConfigPath(): string {
  return path.join(harnessHome(), "mcp.json");
}

/** Read and validate mcp.json; a missing file means no servers. */
export function loadMcpConfig(file = mcpConfigPath()): Record<string, McpServerConfig> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw)) throw new ConfigError(`${file}: expected a JSON object with "mcpServers"`);
  const unknown = Object.keys(raw).filter((k) => k !== "mcpServers");
  if (unknown.length) throw new ConfigError(`${file}: unknown top-level key "${unknown[0]}" (expected "mcpServers")`);
  if (raw.mcpServers === undefined) return {};
  return validateServers(raw.mcpServers, file);
}

/** Validate a `mcpServers` object; `label` names the source in error messages. */
export function validateServers(servers: unknown, label: string): Record<string, McpServerConfig> {
  if (!isObject(servers)) throw new ConfigError(`${label}: "mcpServers" must be an object`);
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const where = `${label}: mcpServers.${name}`;
    if (!SERVER_NAME.test(name) || name.includes("__")) {
      throw new ConfigError(`${where}: server name must use only letters, digits, "_" and "-", without "__"`);
    }
    out[name] = validateServer(value, where);
  }
  return out;
}

function validateServer(value: unknown, where: string): McpServerConfig {
  if (!isObject(value)) throw new ConfigError(`${where} must be an object`);
  if ("url" in value || (value.type !== undefined && value.type !== "stdio")) {
    throw new ConfigError(`${where}: only stdio servers (command + args) are supported`);
  }
  const unknown = Object.keys(value).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw new ConfigError(`${where}: unknown key "${unknown[0]}" (allowed: ${[...KNOWN_KEYS].join(", ")})`);

  if (typeof value.command !== "string" || !value.command.trim()) throw new ConfigError(`${where}.command must be a non-empty string`);
  const strings = (key: string): string[] | undefined => {
    const v = value[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${where}.${key} must be an array of strings`);
    return v as string[];
  };
  const timeout = (key: "callTimeoutMs" | "startupTimeoutMs"): number => {
    const v = value[key];
    if (v === undefined) return MCP_DEFAULTS[key];
    if (typeof v !== "number" || !Number.isInteger(v)) throw new ConfigError(`${where}.${key}=${JSON.stringify(v)} is not an integer`);
    if (v < TIMEOUT_RANGE[0] || v > TIMEOUT_RANGE[1]) {
      throw new ConfigError(`${where}.${key}=${v} is out of range (${TIMEOUT_RANGE[0]}–${TIMEOUT_RANGE[1]})`);
    }
    return v;
  };
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new ConfigError(`${where}.enabled must be true or false`);
  if (value.env !== undefined && (!isObject(value.env) || Object.values(value.env).some((x) => typeof x !== "string"))) {
    throw new ConfigError(`${where}.env must be an object of string values`);
  }
  const hideParams: Record<string, string[]> = {};
  if (value.hideParams !== undefined) {
    if (!isObject(value.hideParams)) throw new ConfigError(`${where}.hideParams must be an object: { "<tool>": ["<param>", ...] }`);
    for (const [tool, params] of Object.entries(value.hideParams)) {
      if (!Array.isArray(params) || params.some((x) => typeof x !== "string")) {
        throw new ConfigError(`${where}.hideParams.${tool} must be an array of parameter names`);
      }
      hideParams[tool] = params as string[];
    }
  }
  return {
    command: value.command,
    args: strings("args") ?? [],
    env: (value.env as Record<string, string> | undefined) ?? {},
    enabled: (value.enabled as boolean | undefined) ?? true,
    includeTools: strings("includeTools"),
    excludeTools: strings("excludeTools") ?? [],
    autoApproveTools: strings("autoApproveTools") ?? [],
    hideParams,
    callTimeoutMs: timeout("callTimeoutMs"),
    startupTimeoutMs: timeout("startupTimeoutMs"),
  };
}

/**
 * The servers to start for a run: explicit `servers` (validated) or mcp.json, narrowed by
 * `--mcp` / `--no-mcp`. Throws ConfigError on invalid configuration or unknown names.
 */
export function resolveMcpServers(opts: McpRunOptions = {}): Record<string, McpServerConfig> {
  if (opts.disabled && opts.only) throw new ConfigError("--no-mcp and --mcp cannot be used together");
  if (opts.disabled) return {};
  const all = opts.servers !== undefined ? validateServers(opts.servers, "option mcp.servers") : loadMcpConfig();
  if (!opts.only) return Object.fromEntries(Object.entries(all).filter(([, s]) => s.enabled));
  const unknown = opts.only.filter((name) => !(name in all));
  if (unknown.length) {
    const known = Object.keys(all);
    throw new ConfigError(`--mcp: unknown server "${unknown[0]}" (configured: ${known.length ? known.join(", ") : "none"})`);
  }
  return Object.fromEntries(opts.only.map((name) => [name, all[name]!]));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
