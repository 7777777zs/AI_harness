// Starts the configured MCP servers for one run and exposes their tools as harness tools.
// Servers connect in parallel; a server that fails to start is reported and skipped, never
// fatal. Every MCP tool asks for confirmation unless its server lists it in autoApproveTools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DENIED, type Tool } from "../types.js";
import type { McpServerConfig } from "./config.js";
import { cleanSchema, convertResult } from "./convert.js";
import { mcpToolName, TOOL_NAME_PATTERN } from "./names.js";
import { ProcessTransport } from "./transport.js";

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed";
  /** Exposed tool names (mcp__server__tool). */
  tools: string[];
  /** Exposed tool names that run without confirmation. */
  autoApproved: string[];
  error?: string;
}

export interface McpEvents {
  /** Something the user should see (failed server, config entry naming no tool, ...). */
  warn(message: string): void;
  /** A structured log entry (JSONL). */
  log(entry: object): void;
}

interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Connection {
  name: string;
  config: McpServerConfig;
  client: Client;
  transport: ProcessTransport;
  /** Set when the server process exits or the connection closes. */
  dead?: string;
}

const MAX_SHOWN_ARGS = 300;

export class McpManager {
  readonly tools: Tool[] = [];
  readonly statuses: McpServerStatus[] = [];
  private readonly connections: Connection[] = [];

  private constructor(private readonly events: McpEvents) {}

  /** Start every server in parallel; failures become "failed" statuses and warnings. */
  static async start(servers: Record<string, McpServerConfig>, cwd: string, events: McpEvents): Promise<McpManager> {
    const manager = new McpManager(events);
    const entries = Object.entries(servers);
    const settled = await Promise.allSettled(entries.map(([name, config]) => connect(name, config, cwd)));
    const taken = new Map<string, string>(); // exposed name -> "server/tool"
    for (const [i, outcome] of settled.entries()) {
      const name = entries[i]![0];
      if (outcome.status === "rejected") {
        manager.fail(name, errorMessage(outcome.reason));
        continue;
      }
      const { connection, tools } = outcome.value;
      try {
        manager.register(connection, tools, taken);
      } catch (err) {
        await connection.client.close().catch(() => {});
        manager.fail(name, errorMessage(err));
      }
    }
    return manager;
  }

  get connected(): number {
    return this.statuses.filter((s) => s.status === "connected").length;
  }

  /** Shut down every server process tree. */
  async close(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.client.close().catch(() => c.transport.close())));
  }

  private fail(name: string, error: string): void {
    this.statuses.push({ name, status: "failed", tools: [], autoApproved: [], error });
    this.events.warn(`MCP server "${name}" is not available: ${error}`);
    this.events.log({ type: "mcp_server_failed", server: name, error });
  }

  /** Filter, name and wrap a connected server's tools; throws on a tool name collision. */
  private register(conn: Connection, serverTools: ServerTool[], taken: Map<string, string>): void {
    const { name: server, config } = conn;
    const available = new Set(serverTools.map((t) => t.name));
    const checkNames = (field: string, names: string[]) => {
      const missing = names.filter((n) => !available.has(n));
      if (missing.length) {
        this.events.warn(`MCP server "${server}": ${field} names tool(s) the server does not have: ${missing.join(", ")}`);
        this.events.log({ type: "mcp_config_warning", server, field, missing });
      }
    };
    checkNames("includeTools", config.includeTools ?? []);
    checkNames("excludeTools", config.excludeTools);
    checkNames("autoApproveTools", config.autoApproveTools);
    checkNames("hideParams", Object.keys(config.hideParams));

    const include = config.includeTools ? new Set(config.includeTools) : null;
    const exclude = new Set(config.excludeTools);
    const autoApprove = new Set(config.autoApproveTools);
    const exposedTools: Tool[] = [];
    const exposedNames = new Map<string, string>();
    for (const t of serverTools) {
      if ((include && !include.has(t.name)) || exclude.has(t.name)) continue;
      const exposed = mcpToolName(server, t.name);
      if (!TOOL_NAME_PATTERN.test(exposed)) throw new Error(`tool "${t.name}" cannot be given a valid name (${exposed})`);
      const clash = exposedNames.get(exposed) ?? taken.get(exposed);
      if (clash) throw new Error(`tool name collision: "${server}/${t.name}" and "${clash}" both map to ${exposed}`);
      exposedNames.set(exposed, `${server}/${t.name}`);

      const hidden = config.hideParams[t.name] ?? [];
      const { schema, changes } = cleanSchema(t.inputSchema, hidden);
      if (changes.length) this.events.log({ type: "mcp_schema_modified", server, tool: t.name, exposed, changes });
      exposedTools.push(this.wrap(conn, t, exposed, schema, hidden, autoApprove.has(t.name)));
    }
    for (const [exposed, origin] of exposedNames) taken.set(exposed, origin);
    this.connections.push(conn);
    this.tools.push(...exposedTools);
    this.statuses.push({
      name: server,
      status: "connected",
      tools: exposedTools.map((t) => t.name),
      autoApproved: exposedTools.filter((t) => autoApprove.has(t.source!.tool)).map((t) => t.name),
    });
  }

  private wrap(
    conn: Connection,
    t: ServerTool,
    exposed: string,
    parameters: Record<string, unknown>,
    hidden: string[],
    autoApproved: boolean,
  ): Tool {
    const { name: server, config } = conn;
    return {
      name: exposed,
      description: `${(t.description ?? "").trim() || t.name} (MCP server "${server}")`,
      parameters,
      source: { kind: "mcp", server, tool: t.name },
      untrusted: true,
      execute: async (args, ctx) => {
        if (conn.dead) return `Error: MCP server "${server}" is not available (${conn.dead})`;
        const blocked = hidden.filter((p) => p in args);
        if (blocked.length) return `Error: parameter "${blocked[0]}" of ${exposed} is disabled by the harness configuration`;
        if (!autoApproved) {
          let shown = JSON.stringify(args);
          if (shown.length > MAX_SHOWN_ARGS) shown = `${shown.slice(0, MAX_SHOWN_ARGS)}…`;
          if (!(await ctx.confirm(`MCP ${server} → ${t.name} ${shown}`))) return DENIED;
        }
        try {
          const result = await conn.client.callTool({ name: t.name, arguments: args }, undefined, { timeout: config.callTimeoutMs });
          return convertResult(result, exposed);
        } catch (err) {
          if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
            return `Error: MCP tool ${exposed} timed out after ${config.callTimeoutMs / 1000}s`;
          }
          if (conn.dead) return `Error: MCP server "${server}" stopped during the call (${conn.dead})`;
          return `Error: MCP tool ${exposed} failed: ${errorMessage(err)}`;
        }
      },
    };
  }
}

/** Spawn, handshake and list tools within the server's startup timeout. */
async function connect(name: string, config: McpServerConfig, cwd: string): Promise<{ connection: Connection; tools: ServerTool[] }> {
  const transport = new ProcessTransport({ command: config.command, args: config.args, env: config.env, cwd });
  const client = new Client({ name: "ai-harness", version: "0.1.0" });
  const connection: Connection = { name, config, client, transport };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not start within ${config.startupTimeoutMs / 1000}s`)), config.startupTimeoutMs);
  });
  const work = (async () => {
    await client.connect(transport, { timeout: config.startupTimeoutMs });
    const all: ServerTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.startupTimeoutMs });
      all.push(...(page.tools as ServerTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  })();
  work.catch(() => {}); // after a startup timeout it rejects later, when the process is killed
  try {
    const tools = await Promise.race([work, timeout]);
    // After connect() the SDK owns onclose; chain onto it to notice a server that exits later.
    const previous = transport.onclose;
    transport.onclose = () => {
      connection.dead ??= "the server process exited";
      previous?.();
    };
    return { connection, tools };
  } catch (err) {
    await transport.close();
    const stderr = transport.stderrTail();
    throw new Error(`${errorMessage(err)}${stderr ? `\n  server stderr (last lines):\n  ${stderr.split("\n").join("\n  ")}` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
