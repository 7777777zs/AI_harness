// A tiny stdio MCP server for tests (plain JS, so it runs with plain `node` from any cwd).
// Environment switches:
//   MOCK_NO_INIT=1   never answer the MCP handshake (startup timeout)
//   MOCK_COLLIDE=1   add a tool whose exposed name collides with another one
//   MOCK_STUBBORN=1  ignore stdin EOF (the harness has to kill the process)
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MOCK_NO_INIT) {
  // Alive but silent.
  setInterval(() => {}, 1_000);
} else {
  if (!process.env.MOCK_STUBBORN) process.stdin.on("end", () => process.exit(0));

  const LONG_NAME = "a_really_long_tool_name_that_keeps_going_well_beyond_the_sixty_four_limit";
  // The start of a 1280x720 PNG: signature and IHDR header (enough for the size to be read).
  const header = Buffer.alloc(33);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(720, 20);
  const PNG = header.toString("base64");
  const object = (properties = {}, required = []) => ({ type: "object", properties, required });

  const tools = [
    { name: "echo", description: "Echo the text back", inputSchema: object({ text: { type: "string" } }, ["text"]) },
    { name: "snap", description: "Take a screenshot", inputSchema: object() },
    { name: "fail", description: "Always fails", inputSchema: object() },
    { name: "hang", description: "Never returns", inputSchema: object() },
    { name: "big", description: "A long page", inputSchema: object() },
    { name: "resources", description: "Embedded resources", inputSchema: object() },
    { name: "spawn_child", description: "Start a grandchild process", inputSchema: object() },
    {
      name: "save",
      description: "Save something",
      inputSchema: object({ what: { type: "string" }, filePath: { type: "string" } }, ["what", "filePath"]),
    },
    { name: "weird.name", description: "Name with a dot", inputSchema: object() },
    {
      name: LONG_NAME,
      description: "Long name and a $schema key",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { q: { type: "string", $comment: "nested" }, $id: { type: "string" } },
      },
    },
  ];
  if (process.env.MOCK_COLLIDE) tools.push({ name: "weird_name", description: "Collides with weird.name", inputSchema: object() });

  /** ~60k chars: a page-like text with a URL, code-like and path-like lines, and a marker in the middle. */
  function bigPage() {
    const lines = ['uid=1_0 RootWebArea "Big page" url="http://127.0.0.1:9/big.html"'];
    let marked = false;
    for (let i = 0, size = 0; size < 60_000; i++, size = lines.join("\n").length) {
      if (!marked && size > 30_000) {
        lines.push('  uid=1_mid StaticText "MIDDLE-MARKER-7731"');
        marked = true;
      }
      lines.push(i % 50 === 0 ? `  def helper_${i}(x):` : i % 7 === 0 ? `  src/app/file_${i}.py` : `  uid=1_${i} StaticText "Paragraph ${i} of the long page."`);
    }
    return lines.join("\n");
  }

  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    switch (req.params.name) {
      case "echo":
        return text(`echo: ${args.text}`);
      case "snap":
        return { content: [{ type: "text", text: "screenshot taken" }, { type: "image", data: PNG, mimeType: "image/png" }] };
      case "fail":
        return { content: [{ type: "text", text: "something broke" }], isError: true };
      case "hang":
        return new Promise(() => {});
      case "big":
        return text(bigPage());
      case "resources":
        return {
          content: [
            { type: "resource", resource: { uri: "mem://notes.txt", mimeType: "text/plain", text: "resource text" } },
            { type: "resource", resource: { uri: "mem://data.bin", mimeType: "application/octet-stream", blob: "AAEC" } },
            { type: "resource_link", uri: "mem://elsewhere", name: "elsewhere" },
          ],
        };
      case "spawn_child": {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        return text(JSON.stringify({ server: process.pid, child: child.pid }));
      }
      case "save":
        return text(`saved ${args.what}`);
      default:
        return text(`called ${req.params.name}`);
    }
  });
  await server.connect(new StdioServerTransport());
}
