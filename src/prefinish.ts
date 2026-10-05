// Pre-finish checks: before a reply without tool calls is accepted as the final answer, the
// harness may send one follow-up (the coverage-check path in agent.ts). This module decides
// whether a reply is only a plan and builds the follow-up messages.

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
