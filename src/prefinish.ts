// Pre-finish checks: before a reply without tool calls is accepted as the final answer, the
// harness may send a follow-up instead (the coverage-check path in agent.ts, within the
// PREFINISH_MAX budget). This module decides whether a reply is only a plan, checks loaded
// skills' completion criteria, and builds the follow-up messages.
import type { Skill } from "./skills/load.js";

/** Sent once when a reply only announces work: without tool calls it would end the run. */
export const PLAN_NUDGE =
  "Your reply only describes what you are going to do, and a reply without tool calls ends the run. " +
  "Do the work now with tool calls. If you truly need information only the user can give, say so in a complete final answer.";

const ACTION =
  "read|open|visit|check|gather|start|navigate|list|look|review|search|fetch|examine|explore|continue|run|write|create|fix|analy[sz]e|inspect|go";
/** "I will read…", "Let me open…", "Next, I'll check…", "…then proceed to read…" */
const EN_ANNOUNCE = new RegExp(
  `\\b(?:I will|I'll|I am going to|I'm going to|I need to|Let me|Next,? I(?:'ll| will)|proceed(?:ing)? to)\\s+(?:now\\s+|first\\s+|then\\s+|next\\s+)?(?:${ACTION})\\b`,
  "i",
);
/** "Next step: read…" (but not "Next steps for you: …"). */
const EN_NEXT_STEP = new RegExp(`^\\s*next step:\\s*(?:${ACTION})\\b`, "i");
/** 我将/接下来/下一步… followed closely by an action verb. */
const ZH_ANNOUNCE = /(?:我将|我会|我要|我先|让我|接下来|下一步)[^。！？\n]{0,6}?(?:读取|打开|查看|检查|阅读|访问|搜索|运行|分析|继续|开始|列出|修复|编写|逐个)/;

/**
 * True if the reply's last paragraph only announces work ("I will read each page…") instead of
 * reporting results. Such a reply has no tool calls, so without a check it would end the run.
 */
export function isPlanOnly(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).at(-1) ?? "";
  return EN_ANNOUNCE.test(last) || EN_NEXT_STEP.test(last) || ZH_ANNOUNCE.test(last);
}

/** What a loaded skill's completion criteria found missing in an answer. */
export interface CompletionGap {
  skill: string;
  /** Failed machine rules, as sentences. */
  failed: string[];
  /** The skill's text criteria, listed for the model to check itself. */
  text: string[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;

/** Distinct URLs in a text (trailing punctuation stripped). */
export function distinctUrls(text: string): string[] {
  return [...new Set((text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/**
 * Gaps in `answer` per loaded skill. Machine rules (requiredSections, minDistinctUrls) decide
 * whether a follow-up is needed; a skill with only text criteria always gets one (an extra step).
 */
export function completionGaps(answer: string, skills: Skill[]): CompletionGap[] {
  const gaps: CompletionGap[] = [];
  for (const skill of skills) {
    const c = skill.completion;
    if (!c) continue;
    const failed: string[] = [];
    for (const pattern of c.requiredSections) {
      if (!new RegExp(pattern, "im").test(answer)) failed.push(`a section matching /${pattern}/ is missing`);
    }
    if (c.minDistinctUrls !== undefined) {
      const found = distinctUrls(answer).length;
      if (found < c.minDistinctUrls) failed.push(`at least ${c.minDistinctUrls} distinct URLs are required; the answer has ${found}`);
    }
    const hasMachineRules = c.requiredSections.length > 0 || c.minDistinctUrls !== undefined;
    if (failed.length > 0 || (!hasMachineRules && c.text.length > 0)) gaps.push({ skill: skill.name, failed, text: c.text });
  }
  return gaps;
}

export function completionMessage(gaps: CompletionGap[]): string {
  const blocks = gaps.map(
    (g) => `Before finishing, check your answer against the completion criteria of the "${g.skill}" skill:\n` + [...g.failed, ...g.text].map((x) => `- ${x}`).join("\n"),
  );
  return (
    `${blocks.join("\n\n")}\n\nRevise your answer so it meets them, or say which ones can't be met and why. ` +
    "Your next reply replaces your previous answer, so it must be complete."
  );
}
