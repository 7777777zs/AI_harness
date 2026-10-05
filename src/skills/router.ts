// Skill router: one call to the compaction model, before the first step, that picks at most one
// skill for the task. Models that ignore a skills list in the prompt (gpt-4.1-mini loaded a
// skill in 0 of 24 runs) still get the right instructions; load_skill stays available on top.
import type { LLMClient, Usage } from "../llm/types.js";
import type { Skill } from "./load.js";

export interface RouteDecision {
  /** The chosen skill, or null for none. */
  skill: string | null;
  reason: string;
  usage: Usage;
  /** Set when the call failed or the reply was unusable (the run continues without a skill). */
  error?: string;
}

export const ROUTER_SYSTEM =
  "You route a task to at most one skill. A skill applies only if the task is clearly the kind of work its " +
  "description names; most tasks need no skill. Reply with JSON only, no other text: " +
  '{"skill": "<skill name>" or null, "reason": "<one short sentence>"}';

export function routerPrompt(task: string, skills: Pick<Skill, "name" | "description">[]): string {
  return `Task:\n${task}\n\nSkills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}

/** Ask `client` which of `skills` fits `task`. Never throws: failures become `skill: null` with `error`. */
export async function routeSkill(client: LLMClient, task: string, skills: Pick<Skill, "name" | "description">[]): Promise<RouteDecision> {
  const none = { inputTokens: 0, outputTokens: 0 };
  let text: string;
  let usage: Usage = none;
  try {
    const response = await client.chat(
      [
        { role: "system", content: ROUTER_SYSTEM },
        { role: "user", content: routerPrompt(task, skills) },
      ],
      [],
    );
    usage = response.usage;
    text = response.text ?? "";
  } catch (err) {
    return { skill: null, reason: "", usage, error: `router call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ...parseDecision(text, skills.map((s) => s.name)), usage };
}

/** Parse the router's reply tolerantly (code fences, text around the JSON); unknown names become null. */
export function parseDecision(text: string, names: string[]): Omit<RouteDecision, "usage"> {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let parsed: unknown;
  try {
    parsed = json ? JSON.parse(json) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { skill: null, reason: "", error: `unusable router reply: ${JSON.stringify(text.slice(0, 200))}` };
  }
  const { skill, reason } = parsed as { skill?: unknown; reason?: unknown };
  const why = typeof reason === "string" ? reason : "";
  if (skill === null || skill === undefined || skill === "" || skill === "null" || skill === "none") return { skill: null, reason: why };
  if (typeof skill !== "string" || !names.includes(skill)) {
    return { skill: null, reason: why, error: `router chose an unknown skill: ${JSON.stringify(skill)}` };
  }
  return { skill, reason: why };
}
