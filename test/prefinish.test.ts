// Pre-finish checks: plan-only replies, skill completion criteria, and the shared follow-up
// budget (with the coverage check). Scripted model; no API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlanOnly } from "../src/prefinish.js";

// ---- Plan-only detection ----

test("plan-only replies: the reply ends by announcing work instead of reporting it", () => {
  for (const plan of [
    // Real gpt-4.1 endings (web-research, Phase 6 follow-up).
    "- The Riverton city archive page lists several links:\n  1. City page\n  2. Encyclopedia\n\nI will read each of these pages to gather information on when the Harbor Point Bridge opened and its length.",
    "Here are the candidate sources as required by step 2 of the web-research skill, then proceed to read them for facts about the opening date and length of the Harbor Point Bridge.",
    "Next step: read src/duration.js and write a failing test.",
    "Let me open the release notes page to find the deployment code.",
    "I'll now check the remaining files under src/.",
    "接下来我将逐个打开这些页面，查找大桥的开通年份和长度。",
    "下一步：运行测试，确认新加的测试会失败。",
  ]) {
    assert.equal(isPlanOnly(plan), true, plan);
  }
});

test("genuine final answers are not plans, even when they mention future work or offer help", () => {
  for (const answer of [
    "The Harbor Point Bridge opened in 1931 (http://x/city.html) and is 412 m long.",
    "## Root cause\n`src/duration.js:15` strips the 0 of 30s.\n\n## Results\nNew test: PASS. Full suite: 7 passed.",
    "Done. I created notes/greeting.txt.\n\nLet me know if you need anything else.",
    "The file contains 137 lines.\n\nIf you want, I can also count the words.",
    "I will not modify check.js, as requested; the fix is in sum.js line 3.",
    "Summary:\n- api/: HTTP handlers\n- services/: business logic\n\nNext steps for you: run `npm test` to verify.",
    "已完成：把 timeout 从 30 改成了 60，文件其他内容没有变。",
    "这个项目分为三层：api 处理请求，services 负责业务逻辑，store 负责持久化。如有需要我可以再详细说明。",
  ]) {
    assert.equal(isPlanOnly(answer), false, answer);
  }
});
