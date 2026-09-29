import path from "node:path";
import type { EvalTask } from "../types.js";
import { fail, pass, randomCode, write } from "../helpers.js";
import { chromeDevtoolsServer, htmlPage } from "../web.js";

/** Per-run answer codes, keyed by the run's base directory (safe with concurrency). */
const answers = new Map<string, string>();

export const task: EvalTask = {
  id: "read-page",
  description: "Open a local web page with Chrome DevTools MCP and report a fact from its body text",
  prompt: ({ baseUrl }) => `Open ${baseUrl}/lighthouse.html in the browser and tell me the logbook code of the lighthouse keeper.`,
  mcpServers: chromeDevtoolsServer(),
  site(siteDir) {
    const code = randomCode("LOG");
    answers.set(path.dirname(siteDir), code);
    write(
      siteDir,
      "lighthouse.html",
      htmlPage(
        "Harbor Point Lighthouse",
        `<h1>Harbor Point Lighthouse</h1>
<p>The lighthouse was built in 1874 and automated in 1962. Its lamp is visible for 22 nautical miles.</p>
<p>Visitors can climb the 117 steps to the gallery between April and October.</p>
<p>The current keeper records every inspection in a logbook; the logbook code is ${code}.</p>
<p>A small museum in the former oil house shows the original Fresnel lens.</p>`,
      ),
    );
  },
  check(dir, result) {
    const code = answers.get(path.dirname(dir));
    answers.delete(path.dirname(dir));
    if (!code) return fail("site setup did not run");
    if (result.mcp.calls === 0) return fail("the page was not opened through the MCP browser tools");
    if (!(result.finalText ?? "").includes(code)) return fail(`final answer does not contain ${code}`);
    return pass();
  },
};
