// Web eval support: a static fixture server on 127.0.0.1 and the Chrome DevTools MCP server
// configuration used by the web tasks (headless, isolated profile, read-only tools only).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { McpServerInput } from "../src/mcp/config.js";

/** Pinned so eval results are reproducible. */
export const CHROME_DEVTOOLS_MCP = "chrome-devtools-mcp@1.10.1";

/** Read-only page tools; nothing that clicks, types, runs scripts or writes files. */
export const READ_ONLY_CHROME_TOOLS = ["list_pages", "select_page", "new_page", "navigate_page", "take_snapshot", "wait_for"];

export function chromeDevtoolsServer(): Record<string, McpServerInput> {
  return {
    "chrome-devtools": {
      command: "npx",
      // --isolated: a fresh temporary profile per run, so concurrent runs don't share a browser.
      args: ["-y", CHROME_DEVTOOLS_MCP, "--headless", "--isolated", "--no-usage-statistics"],
      includeTools: READ_ONLY_CHROME_TOOLS,
      autoApproveTools: READ_ONLY_CHROME_TOOLS,
      hideParams: { take_snapshot: ["filePath"], navigate_page: ["initScript"] },
      startupTimeoutMs: 60_000,
    },
  };
}

/** Download the pinned package into the npx cache once, so a run's startup timeout doesn't include it. */
export function prewarmChromeDevtools(): void {
  // One command string: npx is npx.cmd on Windows, which needs a shell.
  const r = spawnSync(`npx -y ${CHROME_DEVTOOLS_MCP} --version`, { stdio: "ignore", shell: true, timeout: 300_000 });
  if (r.status !== 0) console.warn(`Warning: pre-warming ${CHROME_DEVTOOLS_MCP} failed (status ${r.status})`);
}

export interface SiteServer {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain" };

/** Serve `root` on 127.0.0.1 (random port). Only files inside `root`; everything else is 404. */
export function serveSite(root: string): Promise<SiteServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
}
