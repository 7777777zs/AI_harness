import type { LLMClient, Message, Usage } from "../llm/types.js";
import type { Summarizer } from "./compact.js";

const MAX_ITEM_CHARS = 2_000;

const SYSTEM_PROMPT =
  "You compress the history of an AI coding agent's session so it can continue with less context. " +
  "Write a concise summary with these sections: Task progress, Files touched (paths and what changed), " +
  "Key findings (facts, values, and results the agent will still need), Open issues. " +
  "Keep exact file names, identifiers, numbers and codes. Do not invent anything.";

function clip(s: string): string {
  return s.length > MAX_ITEM_CHARS ? `${s.slice(0, MAX_ITEM_CHARS)}… [${s.length} chars]` : s;
}

/** Render messages as plain text so the summary request carries no tool-call structure. */
export function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      switch (m.role) {
        case "system":
          return `SYSTEM: ${clip(m.content)}`;
        case "user":
          return `USER: ${clip(m.content)}`;
        case "assistant": {
          const calls = m.toolCalls.map((c) => `  -> called ${c.name}(${clip(JSON.stringify(c.args ?? {}))})`);
          return [`ASSISTANT: ${m.content ?? ""}`, ...calls].join("\n");
        }
        case "tool":
          return `TOOL RESULT (${m.name}): ${clip(m.content)}`;
      }
    })
    .join("\n\n");
}

/** A Summarizer backed by an LLM call with no tools. Reports token usage via `onUsage`. */
export function makeSummarizer(client: LLMClient, onUsage: (u: Usage) => void): Summarizer {
  return async (older, task) => {
    const response = await client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Original task:\n${task}\n\nConversation to summarize:\n\n${renderTranscript(older)}`,
        },
      ],
      [],
    );
    onUsage(response.usage);
    if (!response.text?.trim()) throw new Error("summarizer returned an empty response");
    return response.text.trim();
  };
}
