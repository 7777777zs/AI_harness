// The skills of one run: which are available, which are loaded, the load_skill and
// read_skill_file tools, the pinned instructions, and the read-only rules.
import type { Tool } from "../types.js";
import { readFile } from "../tools/readFile.js";
import { requireString } from "../tools/util.js";
import type { Discovery, Skill } from "./load.js";

/** All loaded skills together may take at most this share of the context limit. */
export const SKILLS_CAP_FRACTION = 0.15;

export interface SkillEnvironment {
  /** Connected MCP servers. */
  mcpServers: string[];
  /** Tool names available in this run. */
  tools: string[];
}

export type LoadOutcome = { ok: true; skill: Skill; tokens: number; message: string } | { ok: false; error: string };

export class SkillRegistry {
  readonly available: Skill[] = [];
  readonly unavailable: { skill: Skill; reason: string }[] = [];
  readonly loaded: Skill[] = [];
  private readonly pinnedBySkill = new Map<string, string>();

  constructor(
    discovery: Discovery,
    env: SkillEnvironment,
    private readonly capTokens: number,
    private readonly tokensOf: (text: string) => number,
  ) {
    for (const skill of discovery.skills) {
      const reason = unmetRequirement(skill, env);
      if (reason) this.unavailable.push({ skill, reason });
      else this.available.push(skill);
    }
  }

  get pinnedTokens(): number {
    return [...this.pinnedBySkill.values()].reduce((sum, text) => sum + this.tokensOf(text), 0);
  }

  /** The loaded skills' instructions, appended to the system message of every request. */
  pinnedText(): string {
    return [...this.pinnedBySkill.values()].join("");
  }

  /** The first loaded read-only skill, if any. */
  readOnlySkill(): Skill | undefined {
    return this.loaded.find((s) => s.readOnly);
  }

  /** The system-prompt section listing the skills (empty when there are none). */
  promptSection(): string {
    if (this.available.length === 0 && this.unavailable.length === 0) return "";
    const lines = [
      ...this.available.map((s) => `- ${s.name}: ${s.description}`),
      ...this.unavailable.map((u) => `- ${u.skill.name} (unavailable: ${u.reason}): ${u.skill.description}`),
    ];
    return (
      "\n\nSkills are tested instructions for specific kinds of tasks. Before your first tool call, check the task " +
      "against this list: if it matches a skill's description, your first tool call is load_skill with that name; " +
      "its instructions are then added to this system message. Load only skills that match.\n" +
      lines.join("\n")
    );
  }

  /** The load_skill description: the available skills are listed where the model chooses tools. */
  private loadSkillDescription(): string {
    const list = this.available.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    return (
      "Load a skill: instructions for a specific kind of task. Call this first, before any other tool, " +
      `when the task matches one of these skills:\n${list}`
    );
  }

  load(name: string): LoadOutcome {
    const skill = this.available.find((s) => s.name === name);
    if (!skill) {
      const off = this.unavailable.find((u) => u.skill.name === name);
      if (off) return { ok: false, error: `Skill "${name}" is unavailable: ${off.reason}` };
      const names = this.available.map((s) => s.name);
      return { ok: false, error: `Unknown skill "${name}"${names.length ? ` (available: ${names.join(", ")})` : ""}` };
    }
    if (this.pinnedBySkill.has(name)) {
      return { ok: true, skill, tokens: 0, message: `Skill "${name}" is already loaded; its instructions are in the system message.` };
    }
    const text = pinned(skill);
    const tokens = this.tokensOf(text);
    if (this.pinnedTokens + tokens > this.capTokens) {
      return {
        ok: false,
        error:
          `Loading skill "${name}" (~${tokens} tokens) would exceed the skills cap of ${this.capTokens} tokens ` +
          `(${SKILLS_CAP_FRACTION * 100}% of CONTEXT_LIMIT; ~${this.pinnedTokens} already used). It was not loaded.`,
      };
    }
    this.pinnedBySkill.set(name, text);
    this.loaded.push(skill);
    const files = skill.files.length ? ` Supporting files (read with read_skill_file): ${skill.files.join(", ")}.` : "";
    return {
      ok: true,
      skill,
      tokens,
      message: `Loaded skill "${name}". Its instructions are now in the system message; follow them.${files}`,
    };
  }

  /** load_skill and read_skill_file; `onLoad` reports each successful load. */
  tools(onLoad: (outcome: Extract<LoadOutcome, { ok: true }>) => void): Tool[] {
    const loadSkill: Tool = {
      name: "load_skill",
      description: this.loadSkillDescription(),
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the list" } },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const outcome = this.load(requireString(args, "name").trim());
        if (!outcome.ok) return `Error: ${outcome.error}`;
        if (outcome.tokens > 0) onLoad(outcome);
        return outcome.message;
      },
    };
    const readSkillFile: Tool = {
      name: "read_skill_file",
      description: "Read a supporting file of a skill (e.g. a checklist). The path is relative to the skill's directory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          path: { type: "string", description: "File path relative to the skill directory, as listed by load_skill" },
          offset: { type: "integer", description: "1-based line number to start reading from" },
          limit: { type: "integer", description: "Maximum number of lines to return" },
        },
        required: ["name", "path"],
        additionalProperties: false,
      },
      execute: async (args, ctx) => {
        const name = requireString(args, "name").trim();
        const skill = this.available.find((s) => s.name === name);
        if (!skill) return `Error: Unknown or unavailable skill "${name}"`;
        // Same path rules as the file tools (incl. symlinks and junctions), rooted at the skill directory.
        try {
          return await readFile.execute({ ...args, name: undefined }, { ...ctx, cwd: skill.dir });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message.replace("outside the working directory", `outside the directory of skill "${name}"`));
        }
      },
    };
    return [loadSkill, readSkillFile];
  }
}

function unmetRequirement(skill: Skill, env: SkillEnvironment): string | null {
  const server = skill.requires.mcp.find((s) => !env.mcpServers.includes(s));
  if (server) return `requires MCP server ${server}, which is not connected`;
  const tool = skill.requires.tools.find((t) => !env.tools.includes(t));
  if (tool) return `requires tool ${tool}, which is not available`;
  return null;
}

function pinned(skill: Skill): string {
  const readOnly = skill.readOnly
    ? "\n(Read-only skill: while it is loaded, write_file and edit_file are disabled, and run_shell only runs " +
      "git diff, git log, git show and git status.)"
    : "";
  const files = skill.files.length ? `\n(Supporting files, read with read_skill_file: ${skill.files.join(", ")})` : "";
  return `\n\n## Skill: ${skill.name}${readOnly}${files}\n\n${skill.body}`;
}

// ---------------------------------------------------------------------------------------
// Read-only skills
// ---------------------------------------------------------------------------------------

/** The read-only git commands run_shell still accepts while a read-only skill is active. */
export const READ_ONLY_GIT = ["diff", "log", "show", "status"] as const;
/**
 * `git <diff|log|show|status>` with plain arguments only. The character set excludes everything
 * that chains, substitutes or redirects in cmd.exe or sh: ; & | ` $ ( ) < > ^ % ! quotes, newlines.
 */
const READ_ONLY_COMMAND = new RegExp(`^git[ ]+(${READ_ONLY_GIT.join("|")})(?:[ ]+[A-Za-z0-9_\\-./:=@~,+ ]*)?$`);
/** Options of these commands that write files or run external programs. */
const UNSAFE_OPTION = /(?:^| )--(?:output|ext-diff|textconv)(?:=| |$)/;

/** Null if `command` may run while a read-only skill is active, else the reason it may not. */
export function readOnlyShellViolation(command: string): string | null {
  const c = command.trim();
  if (!READ_ONLY_COMMAND.test(c)) {
    return `only ${READ_ONLY_GIT.map((g) => `git ${g}`).join(", ")} with plain arguments are allowed (no ; & | \` $ ( ) < > ^ % ! quotes or newlines)`;
  }
  if (UNSAFE_OPTION.test(c)) return "--output, --ext-diff and --textconv are not allowed (they write files or run external programs)";
  return null;
}

/**
 * Why `tool` may not run while the read-only skill `skill` is active, or null if it may:
 * write_file and edit_file never, run_shell only for the read-only git commands, and MCP tools
 * only if they are auto-approved (the others click, type or run scripts).
 */
export function readOnlyViolation(
  skill: string,
  tool: Pick<Tool, "name" | "source" | "autoApproved"> | undefined,
  args: Record<string, unknown> | null,
): string | null {
  if (!tool) return null;
  const prefix = `Error: the active skill "${skill}" is read-only`;
  if (tool.name === "write_file" || tool.name === "edit_file") return `${prefix}; ${tool.name} is disabled for the rest of the run.`;
  if (tool.name === "run_shell") {
    const command = typeof args?.command === "string" ? args.command : "";
    const why = readOnlyShellViolation(command);
    return why ? `${prefix}; run_shell rejected: ${why}.` : null;
  }
  if (tool.source?.kind === "mcp" && !tool.autoApproved) return `${prefix}; ${tool.name} needs confirmation and may change things, so it is disabled.`;
  return null;
}
