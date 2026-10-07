// MCP client: discovery and naming, filtering, schema cleanup, result conversion, timeouts,
// failed servers, process cleanup, confirmation, the untrusted-content guard, pagination,
// configuration and eval isolation. Uses a mock stdio server; no Chrome, no API calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, UNTRUSTED_CONTENT_NOTE, untrustedEndTag, untrustedTag } from "../src/agent.js";
import { taskUrls, unopenedUrlStatus } from "../src/taskUrls.js";
import { ConfigError } from "../src/config.js";
import { STATUS_PREFIX } from "../src/context/coverage.js";
import { elideToolResults } from "../src/context/compact.js";
import { isListing } from "../src/context/listing.js";
import { ContextStore } from "../src/context/store.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "../src/llm/types.js";
import { loadMcpConfig, resolveMcpServers, validateServers, type McpServerInput } from "../src/mcp/config.js";
import { cleanSchema, convertResult, imageSize } from "../src/mcp/convert.js";
import { mcpToolName, TOOL_NAME_PATTERN } from "../src/mcp/names.js";
import { ResultPages, type PageLimits } from "../src/mcp/resultPages.js";
import { isAlive, liveChildren } from "../src/process.js";
import { DENIED } from "../src/types.js";
import { evalSettings } from "../evals/options.js";
import type { EvalTask } from "../evals/types.js";

const MOCK = path.join(import.meta.dirname, "fixtures", "mock-mcp-server.mjs");
const LONG_NAME = "a_really_long_tool_name_that_keeps_going_well_beyond_the_sixty_four_limit";
const mock = (extra: Partial<McpServerInput> = {}, env: Record<string, string> = {}): McpServerInput => ({
  command: process.execPath,
  args: [MOCK],
  env,
  ...extra,
});

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-mcp-"));
  created.push(dir);
  return dir;
};
const logOf = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

type Call = { name: string; args: Record<string, unknown> };
/** A scripted model: step n emits `steps[n]` as tool calls (all in one turn), then answers. */
function scripted(steps: Call[][], final = "done") {
  const requests: { messages: Message[]; tools: ToolDefinition[] }[] = [];
  const client: LLMClient = {
    async chat(messages, tools): Promise<LLMResponse> {
      const n = requests.push({ messages: structuredClone(messages), tools }) - 1;
      const usage = { inputTokens: 1, outputTokens: 1 };
      const calls = steps[n];
      if (!calls) return { text: final, toolCalls: [], usage, raw: null };
      return { text: null, toolCalls: calls.map((c, i) => ({ id: `c${n}_${i}`, ...c })), usage, raw: null };
    },
  };
  /** Tool results by call id across all requests. */
  const results = () => {
    const out = new Map<string, string>();
    // Without the untrusted-content tags (checked separately); on errors they follow "Error: ".
    const untag = (s: string) =>
      s.replace(/^(Error: )?\[Untrusted content from [^\]]*\]\n/, "$1").replace(/\n\[End of untrusted content from [^\]]*\]$/, "");
    for (const r of requests) {
      for (const m of r.messages) if (m.role === "tool") out.set(m.toolCallId, untag(m.content));
    }
    return out;
  };
  return { client, requests, results };
}

async function waitDead(pids: number[], ms = 5_000): Promise<number[]> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pids.every((p) => !isAlive(p))) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.filter(isAlive);
}

// ---- Naming ----

test("names: mcp__server__tool, invalid characters replaced, long names cut deterministically", () => {
  assert.equal(mcpToolName("chrome-devtools", "take_snapshot"), "mcp__chrome-devtools__take_snapshot");
  assert.equal(mcpToolName("s", "weird.name"), "mcp__s__weird_name");
  const long = mcpToolName("mock", LONG_NAME);
  assert.equal(long.length, 64);
  assert.match(long, TOOL_NAME_PATTERN);
  assert.equal(long, mcpToolName("mock", LONG_NAME), "deterministic");
  assert.notEqual(long, mcpToolName("mock", `${LONG_NAME}_2`), "distinct long names stay distinct");
});

test("discovery: every tool is exposed with a valid name; read_tool_result and the untrusted-content note are added", async () => {
  const { client, requests } = scripted([]);
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, mcp: { servers: { mock: mock() } } });
  assert.equal(result.stopReason, "done");
  const names = requests[0]!.tools.map((t) => t.name);
  for (const n of ["mcp__mock__echo", "mcp__mock__weird_name", mcpToolName("mock", LONG_NAME), "read_tool_result", "read_file"]) {
    assert.ok(names.includes(n), n);
  }
  for (const n of names) assert.match(n, TOOL_NAME_PATTERN);
  const system = requests[0]!.messages[0]!.content!;
  // The system prompt lists what each MCP tool does.
  assert.ok(system.includes("\n- mcp__mock__echo: Echo the text back\n"), system);
  assert.ok(system.endsWith(UNTRUSTED_CONTENT_NOTE));
  // A URL in the task is a web address to open with an MCP tool, not a file (gpt-4.1-mini refused
  // local URLs in ~10% of first steps without this; see evals/url-check.ts).
  assert.match(system, /A URL in the task \(including localhost and 127\.0\.0\.1\) is not a file in the working directory/);
  // run_start lists the servers, tool counts and auto-approved tools.
  const start = logOf(result.logFile).find((l) => l.type === "run_start");
  assert.equal(start.mcp[0].name, "mock");
  assert.equal(start.mcp[0].status, "connected");
  assert.equal(start.mcp[0].tools.length, 10);
  assert.deepEqual(start.mcp[0].autoApproved, []);
});

test("no MCP servers: tools and system prompt are unchanged", async () => {
  const { client, requests } = scripted([]);
  await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, mcp: { servers: {} } });
  assert.ok(!requests[0]!.tools.some((t) => t.name.startsWith("mcp__") || t.name === "read_tool_result"));
  assert.ok(!requests[0]!.messages[0]!.content!.includes("MCP"));
});

test("a tool name collision fails that server with a clear message; other servers still work", async () => {
  const { client, requests } = scripted([]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    mcp: { servers: { clash: mock({}, { MOCK_COLLIDE: "1" }), ok: mock() } },
  });
  assert.equal(result.stopReason, "done");
  const clash = result.mcp.servers.find((s) => s.name === "clash")!;
  assert.equal(clash.status, "failed");
  assert.match(clash.error!, /collision: "clash\/weird_name" and "clash\/weird\.name" both map to mcp__clash__weird_name/);
  assert.ok(requests[0]!.tools.some((t) => t.name === "mcp__ok__echo"));
  assert.ok(!requests[0]!.tools.some((t) => t.name.startsWith("mcp__clash__")));
});

// ---- Filtering and schemas ----

test("includeTools / excludeTools filter the exposed tools; unknown names give a warning", async () => {
  const { client, requests } = scripted([]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    mcp: { servers: { mock: mock({ includeTools: ["echo", "big", "nope"], excludeTools: ["big"] }) } },
  });
  const mcpTools = requests[0]!.tools.filter((t) => t.name.startsWith("mcp__")).map((t) => t.name);
  assert.deepEqual(mcpTools, ["mcp__mock__echo"]);
  const warning = logOf(result.logFile).find((l) => l.type === "mcp_config_warning");
  assert.deepEqual([warning.field, warning.missing], ["includeTools", ["nope"]]);
});

test("schema cleanup: $schema/$id/$comment keywords removed (not property names), logged; hideParams removes and rejects params", async () => {
  const unit = cleanSchema({ $schema: "x", type: "object", properties: { $id: { type: "string", $comment: "c" } } });
  assert.deepEqual(unit.schema, { type: "object", properties: { $id: { type: "string" } } });
  assert.deepEqual(unit.changes, ["removed $schema", "removed $comment"]);
  assert.deepEqual(cleanSchema(undefined).schema, { type: "object", properties: {} });

  const { client, requests, results } = scripted([[{ name: "mcp__mock__save", args: { what: "a", filePath: "C:/x.txt" } }]]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    mcp: { servers: { mock: mock({ hideParams: { save: ["filePath"] } }) } },
  });
  const tools = new Map(requests[0]!.tools.map((t) => [t.name, t.parameters as Record<string, any>]));
  const long = tools.get(mcpToolName("mock", LONG_NAME))!;
  assert.ok(!("$schema" in long));
  assert.ok("$id" in long.properties, "a parameter named $id is kept");
  const save = tools.get("mcp__mock__save")!;
  assert.deepEqual(Object.keys(save.properties), ["what"]);
  assert.deepEqual(save.required, ["what"]);
  assert.match(results().get("c0_0")!, /^Error: parameter "filePath" of mcp__mock__save is disabled/);
  const modified = logOf(result.logFile).filter((l) => l.type === "mcp_schema_modified");
  assert.ok(modified.some((l) => l.tool === LONG_NAME && l.changes.includes("removed $schema")));
  assert.ok(modified.some((l) => l.tool === "save" && l.changes.includes("hid parameter filePath")));
});

// ---- Results ----

test("result conversion: text joined, image replaced by a note with its size, resources, isError", async () => {
  assert.deepEqual(imageSize(Buffer.from("not an image").toString("base64")), null);
  assert.equal(convertResult({ content: [], structuredContent: { a: 1 } }, "t"), '{\n  "a": 1\n}');
  assert.equal(convertResult({ content: [] }, "t"), "(no content)");

  const { client, results, requests } = scripted([
    [
      { name: "mcp__mock__echo", args: { text: "hi" } },
      { name: "mcp__mock__snap", args: {} },
      { name: "mcp__mock__fail", args: {} },
      { name: "mcp__mock__resources", args: {} },
    ],
  ]);
  await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, autoApprove: true, mcp: { servers: { mock: mock() } } });
  // MCP results are wrapped in the untrusted-content tags; errors too (their text can come from
  // the page), after the "Error:" prefix that marks a failed call.
  const raw = new Map(requests[1]!.messages.flatMap((m) => (m.role === "tool" ? [[m.toolCallId, m.content] as const] : [])));
  assert.equal(raw.get("c0_0"), `${untrustedTag("mcp__mock__echo")}\necho: hi\n${untrustedEndTag("mcp__mock__echo")}`);
  assert.equal(raw.get("c0_2"), `Error: ${untrustedTag("mcp__mock__fail")}\nsomething broke\n${untrustedEndTag("mcp__mock__fail")}`);
  const r = results();
  assert.equal(r.get("c0_0"), "echo: hi");
  assert.equal(r.get("c0_1"), "screenshot taken\n[image omitted: image/png, 1280x720, from mcp__mock__snap]");
  assert.equal(r.get("c0_2"), "Error: something broke");
  assert.equal(
    r.get("c0_3"),
    "[resource mem://notes.txt]\nresource text\n[binary resource omitted: mem://data.bin (application/octet-stream)]\n" +
      "[resource link: mem://elsewhere (elsewhere)]",
  );
});

test("call timeout: the hanging call returns an error, the next call works", async () => {
  const { client, results } = scripted([[{ name: "mcp__mock__hang", args: {} }], [{ name: "mcp__mock__echo", args: { text: "after" } }]]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    // echo is auto-approved: otherwise the guard would ask for it after MCP content (I9).
    mcp: { servers: { mock: mock({ callTimeoutMs: 1_000, autoApproveTools: ["echo"] }) } },
  });
  assert.equal(result.stopReason, "done");
  assert.equal(results().get("c0_0"), "Error: MCP tool mcp__mock__hang timed out after 1s");
  assert.equal(results().get("c1_0"), "echo: after");
});

// ---- Startup failures and process cleanup ----

test("servers that fail to start (bad command, no handshake) are skipped; the run continues", async () => {
  const { client, requests } = scripted([]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    mcp: {
      servers: {
        bad: { command: "definitely-not-a-command-5731" },
        silent: mock({ startupTimeoutMs: 1_000 }, { MOCK_NO_INIT: "1" }),
        good: mock(),
      },
    },
  });
  assert.equal(result.stopReason, "done");
  const status = Object.fromEntries(result.mcp.servers.map((s) => [s.name, s]));
  assert.equal(status.bad!.status, "failed");
  assert.equal(status.silent!.status, "failed");
  assert.match(status.silent!.error!, /did not start within 1s/);
  assert.equal(status.good!.status, "connected");
  assert.ok(requests[0]!.tools.some((t) => t.name === "mcp__good__echo"));
  assert.equal(logOf(result.logFile).filter((l) => l.type === "mcp_server_failed").length, 2);
  assert.deepEqual(liveChildren(), [], "no server process is still tracked");
});

/** Run the mock's spawn_child tool; returns the server and grandchild pids after the run ended. */
async function pidsAfterRun(opts: { env?: Record<string, string>; clientError?: boolean }) {
  const { client, results } = scripted([[{ name: "mcp__mock__spawn_child", args: {} }]]);
  const failing: LLMClient = {
    chat: async (m, t) => {
      // The request after the tool call fails (the scripted client still records it).
      const response = await client.chat(m, t);
      if (m.some((x) => x.role === "tool")) throw new Error("model crashed");
      return response;
    },
  };
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client: opts.clientError ? failing : client,
    quiet: true,
    autoApprove: true,
    mcp: { servers: { mock: mock({}, opts.env ?? {}) } },
  });
  const pids = JSON.parse(results().get("c0_0")!) as { server: number; child: number };
  return { result, pids: [pids.server, pids.child] };
}

test("shutdown kills the server and the processes it started: normal end", async () => {
  const { result, pids } = await pidsAfterRun({});
  assert.equal(result.stopReason, "done");
  assert.deepEqual(await waitDead(pids), [], "server and grandchild are gone");
});

test("shutdown kills the process tree when the run ends with an error", async () => {
  const { result, pids } = await pidsAfterRun({ clientError: true });
  assert.equal(result.stopReason, "error");
  assert.deepEqual(await waitDead(pids), []);
});

test("shutdown kills a server that ignores stdin EOF", async () => {
  const { pids } = await pidsAfterRun({ env: { MOCK_STUBBORN: "1" } });
  assert.deepEqual(await waitDead(pids), []);
});

// ---- Confirmation ----

test("autoApproveTools run without confirmation; other MCP tools ask (server, tool, args) and can be denied", async () => {
  const prompts: string[] = [];
  const { client, results } = scripted([
    [
      { name: "mcp__mock__echo", args: { text: "free" } },
      { name: "mcp__mock__save", args: { what: "x".repeat(400), filePath: "a" } },
    ],
  ]);
  await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    confirm: async (s) => {
      prompts.push(s);
      return false;
    },
    mcp: { servers: { mock: mock({ autoApproveTools: ["echo"] }) } },
  });
  assert.equal(results().get("c0_0"), "echo: free");
  assert.equal(results().get("c0_1"), DENIED);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /^MCP mock → save \{"what":"x{280,}…$/);
  assert.ok(prompts[0]!.length < 360, "arguments are truncated");
});

// ---- Untrusted-content guard ----

test("guard: after MCP content, run_shell needs confirmation even with autoApprove; denial keeps the guard, approval clears it", async () => {
  const asked: string[] = [];
  const answers = [false, true];
  const { client, results } = scripted([
    [{ name: "mcp__mock__echo", args: { text: "page" } }],
    [{ name: "run_shell", args: { command: "echo one" } }],
    [{ name: "run_shell", args: { command: "echo two" } }],
    [{ name: "run_shell", args: { command: "echo three" } }],
  ]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    confirmUntrusted: async (s) => {
      asked.push(s);
      return answers.shift()!;
    },
    mcp: { servers: { mock: mock({ autoApproveTools: ["echo"] }) } },
  });
  assert.equal(asked.length, 2, "asked for 'one' (denied) and 'two' (approved), not for 'three'");
  assert.match(asked[0]!, /^run_shell -> echo one\n⚠ This action comes right after the model read content from an MCP tool/);
  assert.equal(results().get("c1_0"), DENIED);
  assert.match(results().get("c2_0")!, /two/);
  assert.match(results().get("c3_0")!, /three/);
  assert.deepEqual(result.untrustedGuard.map((g) => [g.tool, g.approved]), [["run_shell", false], ["run_shell", true]]);
  assert.equal(result.toolCalls.run_shell, 3);
  const logged = logOf(result.logFile).filter((l) => l.type === "post_untrusted_action");
  assert.deepEqual(logged.map((l) => l.approved), [false, true]);
});

test("guard: calls in the same turn as the MCP call are not guarded; write_file in the next turn is", async () => {
  const asked: string[] = [];
  const { client, results } = scripted([
    [
      { name: "mcp__mock__echo", args: { text: "page" } },
      { name: "write_file", args: { path: "same-turn.txt", content: "a" } },
    ],
    [{ name: "write_file", args: { path: "next-turn.txt", content: "b" } }],
  ]);
  const dir = sandbox();
  const result = await runAgent({
    task: "x",
    cwd: dir,
    client,
    quiet: true,
    autoApprove: true,
    confirmUntrusted: async (s) => {
      asked.push(s);
      return false;
    },
    mcp: { servers: { mock: mock() } },
  });
  assert.ok(fs.existsSync(path.join(dir, "same-turn.txt")));
  assert.ok(!fs.existsSync(path.join(dir, "next-turn.txt")));
  assert.equal(results().get("c1_0"), DENIED);
  assert.equal(asked.length, 1);
  assert.equal(result.untrustedGuard.length, 1);
});

test("guard: under autoApprove, an MCP tool its server does not auto-approve needs confirmation after MCP content (I9)", async () => {
  const asked: string[] = [];
  const { client, results } = scripted([
    [{ name: "mcp__mock__echo", args: { text: "page with injected text" } }], // auto-approved; arms the guard
    [{ name: "mcp__mock__snap", args: {} }], // not auto-approved: guarded
    [{ name: "mcp__mock__echo", args: { text: "again" } }], // auto-approved: not guarded
  ]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    confirmUntrusted: async (s) => {
      asked.push(s);
      return false;
    },
    mcp: { servers: { mock: mock({ autoApproveTools: ["echo"] }) } },
  });
  assert.equal(results().get("c1_0"), DENIED);
  assert.notEqual(results().get("c2_0"), DENIED);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /MCP mock → snap/);
  assert.deepEqual(result.untrustedGuard.map((g) => [g.tool, g.approved]), [["mcp__mock__snap", false]]);
});

// ---- Pagination, listing detection and compaction labels ----

test("oversized MCP results are paginated within the result cap; read_tool_result reaches the middle", async () => {
  const contextLimit = 20_000;
  const { client, results } = scripted([
    [{ name: "mcp__mock__big", args: {} }],
    [{ name: "read_tool_result", args: { id: "mcp-1", offset: 25_000, limit: 10_000 } }], // marker at ~30k
    [{ name: "read_tool_result", args: { id: "nope", offset: 0 } }],
    [{ name: "read_tool_result", args: { id: "mcp-1", pattern: "middle-marker" } }],
  ]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    contextLimit,
    mcp: { servers: { mock: mock() } },
  });
  assert.equal(result.stopReason, "done");
  const first = results().get("c0_0")!;
  assert.match(
    first,
    /\n\[Showing chars 1–[\d,]+ of [\d,]+\. Search this result with read_tool_result id="mcp-1" pattern="<text>", or read on with offset=\d+\.\]$/,
  );
  assert.ok(first.length <= 10_300);
  assert.ok(!first.includes("MIDDLE-MARKER"));
  const middle = results().get("c1_0")!;
  assert.ok(middle.includes("MIDDLE-MARKER-7731"), "the middle of the result is readable");
  assert.match(middle, /\[Showing chars 25,001–/);
  assert.match(results().get("c2_0")!, /^Error: No stored result with id "nope" \(stored: mcp-1\)/);
  // Search finds the line (case-insensitive) with an offset that reads it.
  const found = /^1 line\(s\) in stored result mcp-1 contain "middle-marker":\noffset (\d+): uid=1_mid StaticText "MIDDLE-MARKER-7731"\n/.exec(
    results().get("c3_0")!,
  );
  assert.ok(found, results().get("c3_0"));
  // Not a listing: path-like lines in a web page never become "known files".
  assert.equal(result.coverage.known, 0);
  assert.equal(logOf(result.logFile).filter((l) => l.type === "result_capped").length, 0);
});

test("MCP results are never listings or code: Level 1 labels them by URL, without symbols or paths", async () => {
  const content = ['uid=1_0 RootWebArea "Docs" url="http://127.0.0.1:9/docs.html"', ...Array.from({ length: 80 }, (_, i) => `  src/pkg/mod_${i}.py`), "def secret_helper():", "  pass"].join("\n");
  assert.equal(isListing("mcp__chrome-devtools__take_snapshot", {}, content), false);
  assert.equal(isListing("run_shell", { command: "cat" }, content), true, "the same text from run_shell would count");

  const store = new ContextStore();
  store.record("s1", "mcp__chrome-devtools__take_snapshot", {}, content);
  store.record("n1", "mcp__chrome-devtools__navigate_page", { type: "url", url: "http://127.0.0.1:9/a.html" }, "Navigated.".repeat(200));
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "s1", name: "mcp__chrome-devtools__take_snapshot", args: {} },
        { id: "n1", name: "mcp__chrome-devtools__navigate_page", args: { type: "url", url: "http://127.0.0.1:9/a.html" } },
      ],
    },
    { role: "tool", toolCallId: "s1", name: "mcp__chrome-devtools__take_snapshot", content },
    { role: "tool", toolCallId: "n1", name: "mcp__chrome-devtools__navigate_page", content: "Navigated.".repeat(200) },
    { role: "assistant", content: "ok", toolCalls: [{ id: "x", name: "list_dir", args: {} }] },
    { role: "tool", toolCallId: "x", name: "list_dir", content: "a.txt" },
  ];
  const r = await elideToolResults(messages, { budgetTokens: 1, store });
  const snap = r.messages[3]!.content!;
  assert.match(snap, /^\[Elided: mcp__chrome-devtools__take_snapshot \(url: http:\/\/127\.0\.0\.1:9\/docs\.html"?\) \([\d,]+ chars\)\./);
  assert.ok(!snap.includes("Symbols:") && !snap.includes("Paths ("), snap);
  assert.match(snap, /call the tool again if you need the exact content/);
  assert.match(r.messages[4]!.content!, /^\[Elided: mcp__chrome-devtools__navigate_page \(type: url, url: http:\/\/127\.0\.0\.1:9\/a\.html\)/);
});

// ---- Configuration ----

test("config validation: clear errors for bad values, unknown keys, other transports and bad names", () => {
  const bad = (servers: unknown, pattern: RegExp) =>
    assert.throws(() => validateServers(servers, "mcp.json"), (e: unknown) => e instanceof ConfigError && pattern.test(e.message));
  bad({ s: { command: "" } }, /^mcp\.json: mcpServers\.s\.command must be a non-empty string$/);
  bad({ s: { command: "x", callTimeoutMs: -5 } }, /^mcp\.json: mcpServers\.s\.callTimeoutMs=-5 is out of range \(1000–600000\)$/);
  bad({ s: { command: "x", startupTimeoutMs: "fast" } }, /startupTimeoutMs="fast" is not an integer/);
  bad({ s: { command: "x", autoAproveTools: ["a"] } }, /unknown key "autoAproveTools"/);
  bad({ s: { url: "http://x" } }, /only stdio servers/);
  bad({ s: { command: "x", includeTools: "echo" } }, /includeTools must be an array of strings/);
  bad({ s: { command: "x", hideParams: { t: "p" } } }, /hideParams\.t must be an array/);
  bad({ "a__b": { command: "x" } }, /server name must use only/);
  bad({ "a b": { command: "x" } }, /server name must use only/);
  const ok = validateServers({ s: { command: "x" } }, "mcp.json").s!;
  assert.deepEqual([ok.callTimeoutMs, ok.startupTimeoutMs, ok.enabled, ok.autoApproveTools], [60_000, 30_000, true, []]);
});

test("mcp.json: invalid JSON is a ConfigError; --mcp selects (even disabled servers); --no-mcp disables; both is an error", () => {
  const dir = sandbox();
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, "{ nope");
  assert.throws(() => loadMcpConfig(file), (e: unknown) => e instanceof ConfigError && e.message.startsWith(`${file}: invalid JSON`));
  assert.deepEqual(loadMcpConfig(path.join(dir, "missing.json")), {});

  const servers = { a: { command: "x" }, b: { command: "y", enabled: false } };
  assert.deepEqual(Object.keys(resolveMcpServers({ servers })), ["a"]);
  assert.deepEqual(Object.keys(resolveMcpServers({ servers, only: ["b"] })), ["b"]);
  assert.deepEqual(resolveMcpServers({ servers, disabled: true }), {});
  assert.throws(() => resolveMcpServers({ servers, only: ["c"] }), /--mcp: unknown server "c" \(configured: a, b\)/);
  assert.throws(() => resolveMcpServers({ servers, only: ["a"], disabled: true }), /cannot be used together/);
});

test("CLI: an unknown --mcp name fails at startup with a clear error", () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { mock: mock() } }));
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "--mcp", "nope", "hello"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, HARNESS_HOME: home, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "test-model" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid configuration: --mcp: unknown server "nope" \(configured: mock\)/);
});

test("a runAgent option config with an invalid value ends the run with errorKind config", async () => {
  const { client } = scripted([]);
  const result = await runAgent({ task: "x", cwd: sandbox(), client, quiet: true, mcp: { servers: { s: { command: "x", callTimeoutMs: 1 } } } });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorKind, "config");
  assert.match(result.error!, /callTimeoutMs=1 is out of range/);
});

// ---- Eval isolation ----

test("evals are isolated from ~/.harness/mcp.json: evalSettings passes an explicit (empty) server list", async () => {
  const file = path.join(process.env.HARNESS_HOME!, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { mock: mock() } }));
  try {
    // Without an explicit list the user's file is used...
    const plain = scripted([]);
    const r1 = await runAgent({ task: "x", cwd: sandbox(), client: plain.client, quiet: true });
    assert.ok(plain.requests[0]!.tools.some((t) => t.name === "mcp__mock__echo"), "mcp.json is read by default");
    assert.equal(r1.mcp.servers.length, 1);

    // ...but the eval settings never read it.
    const task: EvalTask = { id: "t", description: "", prompt: "x", check: () => ({ pass: true }) };
    const settings = evalSettings(task, { mainModel: "m" });
    assert.deepEqual(settings.mcp, { servers: {} });
    const evalRun = scripted([]);
    const r2 = await runAgent({ task: "x", cwd: sandbox(), client: evalRun.client, quiet: true, ...settings });
    assert.ok(!evalRun.requests[0]!.tools.some((t) => t.name.startsWith("mcp__")));
    assert.deepEqual(r2.mcp.servers, []);
    assert.ok(!logOf(r2.logFile).some((l) => l.type === "mcp_server_failed"));

    // A task that declares a server gets exactly that server.
    const withServer = evalSettings({ ...task, mcpServers: { other: mock() } }, { mainModel: "m" });
    assert.deepEqual(Object.keys(withServer.mcp.servers!), ["other"]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ---- Stored results: dedupe and memory bound ----

const LIMITS: PageLimits = { maxChars: 10_000, maxTokens: 100_000, tokensOf: (s) => Math.ceil(s.length / 4) };
const page = (tag: string, chars = 30_000) => `${tag}\n` + "x".repeat(chars);
const ctx = { cwd: ".", confirm: async () => true };

test("an oversized result identical to a stored one returns a one-line reference, not the first page again", async () => {
  const pages = new ResultPages();
  const first = pages.paginate(page("SNAPSHOT"), LIMITS);
  assert.match(first, /id="mcp-1"/);
  const again = pages.paginate(page("SNAPSHOT"), LIMITS);
  assert.equal(
    again,
    '[Same content as stored result mcp-1 (30,009 chars, unchanged). Search it with read_tool_result id="mcp-1" pattern="<text>", or read it with offset.]',
  );
  // The duplicate didn't take a new id, and the stored result is still readable.
  assert.match(pages.paginate(page("OTHER"), LIMITS), /id="mcp-2"/);
  assert.match(await pages.tool(() => LIMITS).execute({ id: "mcp-1", offset: 0 }, ctx), /^SNAPSHOT\n/);
});

test("stored results are bounded: the oldest are evicted, reading one is a clear error, and a repeat of evicted content is shown again", async () => {
  const pages = new ResultPages({ maxStoredChars: 70_000 });
  const read = pages.tool(() => LIMITS);
  pages.paginate(page("A"), LIMITS); // mcp-1
  pages.paginate(page("B"), LIMITS); // mcp-2
  pages.paginate(page("C"), LIMITS); // mcp-3: 90k stored > 70k, so mcp-1 is evicted
  assert.equal(
    await read.execute({ id: "mcp-1", offset: 0 }, ctx),
    "Error: Stored result mcp-1 was evicted to bound memory; call the tool again to get its content.",
  );
  assert.match(await read.execute({ id: "mcp-3", offset: 0 }, ctx), /^C\n/);
  // The same content as the evicted mcp-1: shown normally under a new id, not as a reference.
  const repeat = pages.paginate(page("A"), LIMITS);
  assert.match(repeat, /^A\nx+\n\[Showing chars 1–/);
  assert.match(repeat, /id="mcp-4"/);
});

test("a single result larger than the whole bound is still stored (it is the newest)", async () => {
  const pages = new ResultPages({ maxStoredChars: 20_000 });
  assert.match(pages.paginate(page("BIG", 50_000), LIMITS), /id="mcp-1"/);
  assert.match(await pages.tool(() => LIMITS).execute({ id: "mcp-1", offset: 40_000 }, ctx), /^x+/);
});

test("read_tool_result pages are untrusted: tagged, and they re-arm the guard after an approval", async () => {
  const answers = [true, false];
  const asked: string[] = [];
  const { client, requests } = scripted([
    [{ name: "mcp__mock__big", args: {} }], // oversized: paginated; arms the guard
    [{ name: "write_file", args: { path: "notes.txt", content: "ok" } }], // guarded; approved, so the guard clears
    [{ name: "read_tool_result", args: { id: "mcp-1", offset: 25_000 } }], // more untrusted content
    [{ name: "run_shell", args: { command: "echo hi" } }], // must be guarded again
  ]);
  const result = await runAgent({
    task: "x",
    cwd: sandbox(),
    client,
    quiet: true,
    autoApprove: true,
    contextLimit: 20_000,
    confirmUntrusted: async (s) => {
      asked.push(s);
      return answers.shift()!;
    },
    mcp: { servers: { mock: mock() } },
  });
  const page = requests.at(-1)!.messages.find((m) => m.role === "tool" && m.toolCallId === "c2_0")!.content!;
  assert.ok(page.startsWith(untrustedTag("read_tool_result")), "the page is tagged as untrusted");
  // A full page (10k chars plus its note) is kept whole: not paginated again, not head+tail truncated.
  assert.match(page, /\[Showing chars 25,001–/);
  assert.ok(!page.includes("[... truncated:") && !page.includes('id="mcp-2"'), "the page is passed through as it is");
  assert.deepEqual(result.untrustedGuard.map((g) => [g.tool, g.approved]), [["write_file", true], ["run_shell", false]]);
});

// ---- Task URLs (N5) ----

const TASK_URL = "http://127.0.0.1:4321/a.html";

test("taskUrls: http(s) URLs from the task, without trailing punctuation", () => {
  assert.deepEqual(
    taskUrls(`Open ${TASK_URL}. Then compare with (https://example.org/b?x=1), please`).map(String),
    [TASK_URL, "https://example.org/b?x=1"],
  );
  assert.deepEqual(taskUrls("no links here"), []);
});

test("until an MCP call is given the task URL, each request's status names it; tool results get nothing", async () => {
  const { client, requests, results } = scripted([
    [{ name: "mcp__mock__echo", args: { text: "about:blank" } }],
    [{ name: "mcp__mock__echo", args: { text: TASK_URL } }],
  ]);
  const result = await runAgent({ task: `Summarize ${TASK_URL}`, cwd: sandbox(), client, quiet: true, autoApprove: true, mcp: { servers: { mock: mock() } } });
  const status = (n: number) => requests[n]!.messages.at(-1)!;
  const line = unopenedUrlStatus([TASK_URL]);
  for (const n of [0, 1]) {
    assert.equal(status(n).role, "user");
    assert.equal(status(n).content, `${STATUS_PREFIX}\n${line}`, `request ${n}`);
  }
  assert.ok(!requests[2]!.messages.some((m) => m.content?.includes(line)), "gone once a call was given the URL");
  assert.ok(![...results().values()].some((r) => r.includes("Not opened by any tool call")), "never stored in tool results");
  assert.equal(result.nudges.unopenedUrl, 2);
});

test("no unopened-URL status without MCP tools, or when the step's MCP call was given the URL", async () => {
  const noMcp = scripted([]);
  await runAgent({ task: `Summarize ${TASK_URL}`, cwd: sandbox(), client: noMcp.client, quiet: true, autoApprove: true, mcp: { servers: {} } });
  assert.ok(!noMcp.requests[0]!.messages.some((m) => m.content?.includes("Not opened by any tool call")));

  const { client, requests } = scripted([
    [
      { name: "mcp__mock__echo", args: { text: "list" } },
      { name: "mcp__mock__echo", args: { text: TASK_URL } },
    ],
  ]);
  const result = await runAgent({ task: `Summarize ${TASK_URL}`, cwd: sandbox(), client, quiet: true, autoApprove: true, mcp: { servers: { mock: mock() } } });
  assert.ok(!requests[1]!.messages.some((m) => m.content?.includes("Not opened by any tool call")));
  assert.equal(result.nudges.unopenedUrl, 1, "only the first request");
});
