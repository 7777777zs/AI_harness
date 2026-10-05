// Skill discovery: every <dir>/<name>/SKILL.md with valid frontmatter becomes a skill.
// Invalid skills are reported and skipped; they never stop a run.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { harnessHome, PACKAGE_ROOT } from "../config.js";

export interface Skill {
  name: string;
  description: string;
  requires: { mcp: string[]; tools: string[] };
  readOnly: boolean;
  /** Checked before a final answer is accepted while this skill is loaded (see src/prefinish.ts). */
  completion?: CompletionCriteria;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Directory of the skill; supporting files are read from here only. */
  dir: string;
  /** Supporting files (relative paths, "/" separators), excluding SKILL.md. */
  files: string[];
}

export interface CompletionCriteria {
  /** Regexes (case-insensitive); each must match a heading line of the answer. */
  requiredSections: string[];
  /** The answer must contain at least this many distinct URLs. */
  minDistinctUrls?: number;
  /** Criteria only the model can judge; listed in the follow-up. */
  text: string[];
}

export interface Discovery {
  skills: Skill[];
  /** Invalid skills and name collisions, as user-facing messages. */
  warnings: string[];
}

export const SKILL_FILE = "SKILL.md";
export const NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
export const MAX_DESCRIPTION = 300;
const KNOWN_KEYS = new Set(["name", "description", "requires", "readOnly", "completion"]);
const COMPLETION_KEYS = ["requiredSections", "minDistinctUrls", "text"];
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function bundledSkillsDir(): string {
  return path.join(PACKAGE_ROOT, "skills");
}

export function userSkillsDir(): string {
  return path.join(harnessHome(), "skills");
}

/**
 * Skills from `dirs` in order; a later directory's skill replaces an earlier one with the same
 * name (so the default order, bundled then user, lets user skills win), with a warning.
 */
export function discoverSkills(dirs: string[] = [bundledSkillsDir(), userSkillsDir()]): Discovery {
  const byName = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const root of dirs) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, SKILL_FILE);
      if (!fs.existsSync(file)) continue;
      let skill: Skill;
      try {
        skill = parseSkill(fs.readFileSync(file, "utf8"), dir);
      } catch (err) {
        warnings.push(`Skipping skill ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const previous = byName.get(skill.name);
      if (previous) warnings.push(`Skill "${skill.name}" in ${dir} replaces the one in ${previous.dir}`);
      byName.set(skill.name, skill);
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** Parse and validate one SKILL.md; throws an Error with a user-facing reason. */
export function parseSkill(text: string, dir: string): Skill {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("missing YAML frontmatter (the file must start with a --- block)");
  let meta: unknown;
  try {
    meta = parseYaml(m[1]!);
  } catch (err) {
    throw new Error(`invalid YAML frontmatter: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new Error("frontmatter must be a mapping");
  const fm = meta as Record<string, unknown>;
  const unknown = Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw new Error(`unknown frontmatter key "${unknown[0]}" (allowed: ${[...KNOWN_KEYS].join(", ")})`);

  if (typeof fm.name !== "string" || !NAME_PATTERN.test(fm.name)) {
    throw new Error(`"name" must match ${NAME_PATTERN.source} (got ${JSON.stringify(fm.name)})`);
  }
  if (fm.name !== path.basename(dir)) throw new Error(`"name" (${fm.name}) must equal the directory name (${path.basename(dir)})`);
  if (typeof fm.description !== "string" || !fm.description.trim()) throw new Error('"description" is required');
  const description = fm.description.trim().replace(/\s+/g, " ");
  if (description.length > MAX_DESCRIPTION) {
    throw new Error(`"description" is ${description.length} characters (max ${MAX_DESCRIPTION})`);
  }
  if (fm.readOnly !== undefined && typeof fm.readOnly !== "boolean") throw new Error('"readOnly" must be true or false');

  const requires = { mcp: [] as string[], tools: [] as string[] };
  if (fm.requires !== undefined) {
    const r = fm.requires;
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Error('"requires" must be a mapping, e.g. { mcp: [server] }');
    for (const [key, value] of Object.entries(r)) {
      if (key !== "mcp" && key !== "tools") throw new Error(`unknown "requires" key "${key}" (allowed: mcp, tools)`);
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`"requires.${key}" must be a list of names`);
      requires[key] = value as string[];
    }
  }

  // A Windows checkout (core.autocrlf) gives CRLF files; the prompt gets LF.
  const completion = fm.completion === undefined ? undefined : parseCompletion(fm.completion);

  const body = m[2]!.replace(/\r\n/g, "\n").trim();
  if (!body) throw new Error("the skill has no instructions after the frontmatter");
  return {
    name: fm.name,
    description,
    requires,
    readOnly: fm.readOnly === true,
    ...(completion && { completion }),
    body,
    dir,
    files: supportingFiles(dir),
  };
}

function parseCompletion(value: unknown): CompletionCriteria {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('"completion" must be a mapping, e.g. { minDistinctUrls: 2 }');
  }
  const c = value as Record<string, unknown>;
  const unknown = Object.keys(c).filter((k) => !COMPLETION_KEYS.includes(k));
  if (unknown.length) throw new Error(`unknown "completion" key "${unknown[0]}" (allowed: ${COMPLETION_KEYS.join(", ")})`);
  if (Object.keys(c).length === 0) throw new Error(`"completion" needs at least one of ${COMPLETION_KEYS.join(", ")}`);
  const strings = (key: string): string[] => {
    const v = c[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
      throw new Error(`"completion.${key}" must be a list of non-empty strings`);
    }
    return v as string[];
  };
  const requiredSections = strings("requiredSections");
  for (const pattern of requiredSections) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(`"completion.requiredSections" has an invalid regex ${JSON.stringify(pattern)}`);
    }
  }
  const min = c.minDistinctUrls;
  if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min < 1)) {
    throw new Error('"completion.minDistinctUrls" must be a positive integer');
  }
  return { requiredSections, ...(min !== undefined && { minDistinctUrls: min as number }), text: strings("text") };
}

/** Files below the skill directory (two levels deep), excluding SKILL.md. */
function supportingFiles(dir: string, rel = "", depth = 0): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory() && depth < 2) out.push(...supportingFiles(dir, p, depth + 1));
    else if (entry.isFile() && p !== SKILL_FILE) out.push(p);
  }
  return out;
}
