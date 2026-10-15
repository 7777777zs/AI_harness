// Pre-finish checks: before a reply without tool calls is accepted as the final answer, the
// harness may send a follow-up instead (the coverage-check path in agent.ts, within the
// PREFINISH_MAX budget). This module decides whether a reply is only a plan, checks loaded
// skills' completion criteria, and builds the follow-up messages.
import type { Skill } from "./skills/load.js";

/** Sent once when a reply only announces work: without tool calls it would end the run. */
export const PLAN_NUDGE =
  "Your reply only describes what you are going to do, and a reply without tool calls ends the run. " +
  "Do the work now with tool calls. If you truly need information only the user can give, say so in a complete final answer.";

/**
 * Sent when a reply has neither content nor tool calls, e.g. a reasoning model that only thought
 * (I36: qwen3 with thinking on ended runs with an empty answer in step 1).
 */
export const EMPTY_REPLY_NUDGE =
  "Your reply was empty: no text and no tool calls. A reply without tool calls ends the run, so continue the task " +
  "with tool calls now. Reply without tool calls only when the task is complete; that reply is your final answer.";

/**
 * Sent when the reply right after the note-taking reminder has no tool calls: it is the notes the
 * reminder asked for, not an answer (I33: local models stopped there, mid-task).
 */
export const AFTER_NOTES_NUDGE =
  "Noted. A reply without tool calls ends the run, so continue the task with tool calls now. " +
  "Reply without tool calls only when the task is complete; that reply is your final answer.";

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

/** "Let's proceed with these steps." (I38) */
const EN_LETS_PROCEED = /\b(?:let['’]?s|let me) (?:now )?proceed\b/i;
/** "Please confirm you want me to proceed…", "Shall I go ahead…?", "Shall I continue with the next file?" (I38) */
const EN_ASK_PROCEED =
  /\bplease confirm\b[^.?!\n]{0,40}\b(?:you want me to|to) (?:proceed|go ahead|continue)\b|\b(?:shall|should) I\b[^.?!\n]{0,40}\b(?:proceed|go ahead|continue)\b/i;
/** Offers of extra work after a finished task ("Should I continue with the other modules as well?") are answers. */
const EXTRA_WORK = /\b(?:also|too|as well|other|additional|more|else)\b/i;
/** "I will:" followed by a numbered list of steps (I38). */
const EN_NUMBERED_PLAN = /(?:^|\n)\s*(?:I will|I'll|I am going to|I'm going to)\s*:\s*\n\s*1[.)]\s/i;

/**
 * True if the reply's last paragraph only announces work ("I will read each page…", "Let's
 * proceed…") instead of reporting results. Such a reply has no tool calls, so without a check it
 * would end the run.
 */
export function isPlanOnly(text: string): boolean {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  const lastTwo = paragraphs.slice(-2).join("\n");
  const asksToProceed = EN_ASK_PROCEED.test(last) && !EXTRA_WORK.test(last);
  return (
    EN_ANNOUNCE.test(last) || EN_NEXT_STEP.test(last) || ZH_ANNOUNCE.test(last) || EN_LETS_PROCEED.test(last) || asksToProceed || EN_NUMBERED_PLAN.test(lastTwo)
  );
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

/** Lines that start a section: Markdown headings ("## Conflicts") and bold-only lines ("**Conflicts**"). */
function headingLines(answer: string): string[] {
  return answer.split(/\r?\n/).filter((l) => /^\s{0,3}#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(l));
}

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
    const headings = headingLines(answer);
    for (const pattern of c.requiredSections) {
      const re = new RegExp(pattern, "i");
      if (!headings.some((h) => re.test(h))) failed.push(`a section matching /${pattern}/ is missing`);
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
