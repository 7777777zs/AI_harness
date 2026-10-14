// The hard eval suite (tasks 28+): task selection, and each task's check against a reference
// solution and typical wrong answers. No API calls: the agent runs are scripted.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectTasks } from "../evals/options.js";
import { pass } from "../evals/helpers.js";
import type { EvalTask } from "../evals/types.js";

const created: string[] = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
export const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-hard-test-"));
  created.push(d);
  return d;
};

// ---- selection ----

const fake = (id: string, extra: Partial<EvalTask> = {}): EvalTask => ({ id, description: "", prompt: "", check: () => pass(), ...extra });
const ids = (r: { selected: EvalTask[] }) => r.selected.map((t) => t.id);

test("task selection: hard tasks run only with --suite hard; --task finds any task", () => {
  const all = [fake("a"), fake("web", { mcpServers: {} }), fake("skill", { expectedSkill: "s" }), fake("h", { suite: "hard" }), fake("hweb", { suite: "hard", mcpServers: {} })];
  assert.deepEqual(ids(selectTasks(all, {})), ["a", "web", "skill"]);
  assert.deepEqual(ids(selectTasks(all, { suite: "hard" })), ["h", "hweb"]);
  assert.deepEqual(ids(selectTasks(all, { suite: "hard", withoutMcp: true })), ["h"]);
  assert.deepEqual(ids(selectTasks(all, { task: "h" })), ["h"]);
  assert.deepEqual(ids(selectTasks(all, { withoutMcp: true, withoutSkillTasks: true })), ["a"]);
  assert.equal(selectTasks(all, {}).error, null);
});

test("task selection: errors name the reason", () => {
  const all = [fake("a"), fake("web", { mcpServers: {} }), fake("skill", { expectedSkill: "s" }), fake("h", { suite: "hard" })];
  assert.match(selectTasks(all, { task: "zzz" }).error!, /^unknown task "zzz"\. Available: a, web, skill, h$/);
  assert.match(selectTasks(all, { task: "web", withoutMcp: true }).error!, /^task "web" needs an MCP server, and --without-mcp skips it$/);
  assert.match(selectTasks(all, { task: "skill", withoutSkillTasks: true }).error!, /^task "skill" is a with\/without-skills task, and --without-skill-tasks skips it$/);
  assert.match(selectTasks(all, { suite: "easy" }).error!, /^--suite must be default or hard, got "easy"$/);
});
