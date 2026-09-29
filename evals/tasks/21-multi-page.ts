import path from "node:path";
import type { EvalTask } from "../types.js";
import { fail, pass, randomCode, write } from "../helpers.js";
import { chromeDevtoolsServer, htmlPage } from "../web.js";

const answers = new Map<string, string>();

export const task: EvalTask = {
  id: "multi-page",
  description: "The answer is only on a page linked from the start page: the model has to follow the link",
  prompt: ({ baseUrl }) => `Starting from the web page at ${baseUrl}/index.html, find the deployment code of Project Kestrel.`,
  mcpServers: chromeDevtoolsServer(),
  site(siteDir) {
    const code = randomCode("DEPLOY");
    answers.set(path.dirname(siteDir), code);
    write(
      siteDir,
      "index.html",
      htmlPage(
        "Project Kestrel",
        `<h1>Project Kestrel</h1>
<p>Kestrel is the internal name of the new route-planning service. The team ships every second Tuesday.</p>
<p>Deployment codes are not listed here. See the <a href="release-notes.html">release notes</a> for the current deployment code.</p>
<p>Questions go to the platform channel.</p>`,
      ),
    );
    write(
      siteDir,
      "release-notes.html",
      htmlPage(
        "Kestrel release notes",
        `<h1>Kestrel release notes</h1>
<p>This release adds turn-by-turn caching and fixes two timezone bugs.</p>
<p>Current deployment code: ${code}</p>`,
      ),
    );
  },
  check(dir, result, { web }) {
    const code = answers.get(path.dirname(dir));
    answers.delete(path.dirname(dir));
    if (!code) return fail("site setup did not run");
    if (!web?.requests.includes("/release-notes.html")) return fail("the linked page was never loaded");
    if (!(result.finalText ?? "").includes(code)) return fail(`final answer does not contain ${code}`);
    return pass();
  },
};
