import path from "node:path";
import type { EvalTask } from "../types.js";
import { fail, maxRequestTokens, pass, randomCode, write } from "../helpers.js";
import { chromeDevtoolsServer, htmlPage } from "../web.js";

const CONTEXT_LIMIT = 20_000;
const PAGE_CHARS = 120_000;
const answers = new Map<string, string>();

const TOPICS = [
  "Check the backup generator fuel level at the start of every shift and log the reading.",
  "Loading bay doors must be closed when the outside temperature drops below freezing.",
  "Report any damaged pallets to the shift lead before moving them to the returns area.",
  "The fire exits on the east side are inspected on the first Monday of each month.",
  "New staff shadow an experienced operator for two full shifts before working alone.",
  "Forklift batteries are charged in the ventilated room next to the maintenance office.",
];

export const task: EvalTask = {
  id: "long-page",
  description: `A ~${PAGE_CHARS / 1000}k-char page (far above the result cap) with the answer in the middle; no request may exceed CONTEXT_LIMIT`,
  prompt: ({ baseUrl }) =>
    `The page ${baseUrl}/manual.html is a long operations manual. Find the vault combination mentioned in it.`,
  mcpServers: chromeDevtoolsServer(),
  // The snapshot is paginated (pages of at most 10k chars, within the 25% result cap of 20k);
  // reaching the middle takes several read_tool_result calls, so compaction runs as well.
  contextLimit: CONTEXT_LIMIT,
  maxSteps: 30,
  site(siteDir) {
    const code = randomCode("VAULT");
    answers.set(path.dirname(siteDir), code);
    const sections: string[] = [];
    let size = 0;
    let placed = false;
    for (let i = 1; size < PAGE_CHARS; i++) {
      let html = `<h2>Section ${i}</h2>\n`;
      for (let j = 0; j < 6; j++) html += `<p>${i}.${j + 1} ${TOPICS[(i + j) % TOPICS.length]}</p>\n`;
      if (!placed && size > PAGE_CHARS / 2) {
        html += `<p>${i}.7 The vault combination for the records room is ${code}. Do not write it down elsewhere.</p>\n`;
        placed = true;
      }
      sections.push(html);
      size += html.length;
    }
    write(siteDir, "manual.html", htmlPage("Warehouse operations manual", `<h1>Warehouse operations manual</h1>\n${sections.join("")}`));
  },
  check(dir, result) {
    const code = answers.get(path.dirname(dir));
    answers.delete(path.dirname(dir));
    if (!code) return fail("site setup did not run");
    const maxTokens = maxRequestTokens(result.logFile);
    const details = { maxRequestTokens: maxTokens, readToolResultCalls: result.toolCalls.read_tool_result ?? 0 };
    if (maxTokens > CONTEXT_LIMIT) return { ...fail(`a request used ${maxTokens} input tokens > ${CONTEXT_LIMIT}`), details };
    if (!(result.finalText ?? "").includes(code)) return { ...fail(`final answer does not contain ${code}`), details };
    return { ...pass(), details };
  },
};
