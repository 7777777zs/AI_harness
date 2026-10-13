// A local fake chat-completions server (OPENAI_BASE_URL) for tests that run the CLI or the eval
// runner as a child process. The first `answered` chat requests get the final answer "done"; later
// ones hang until close(). `ollamaShow`, if given, is served at /api/show, as an Ollama server
// would; every other path is a 404, as on a server that is not Ollama.
import http from "node:http";

export function fakeApi(
  answered = 1,
  opts: { ollamaShow?: Record<string, unknown> } = {},
): Promise<{ url: string; close: () => void; chatCalls: () => number }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/api/show") && opts.ollamaShow) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.ollamaShow));
        return;
      }
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      if (calls++ >= answered) return; // hang
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        chatCalls: () => calls,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    }),
  );
}
