// Locations, .env loading and validated harness settings, shared by the CLI and the eval runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Root of the harness installation (the directory containing package.json). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Per-user harness directory: ~/.harness, or $HARNESS_HOME if set. */
export function harnessHome(): string {
  return process.env.HARNESS_HOME || path.join(os.homedir(), ".harness");
}

export function logsDir(): string {
  return path.join(harnessHome(), "logs");
}

/**
 * Variables that came from a .env file (not the real process environment), with the file.
 * Filled by loadEnv(); used to report where each setting came from.
 */
export const envFileSources = new Map<string, string>();

/**
 * Load .env files without overriding variables that are already set.
 * Precedence: process environment > ~/.harness/.env > <harness install>/.env.
 * The user's project directory is never read, so its .env can't leak into the harness.
 * Returns the files that were loaded.
 */
export function loadEnv(): string[] {
  const loaded: string[] = [];
  for (const file of [path.join(harnessHome(), ".env"), path.join(PACKAGE_ROOT, ".env")]) {
    if (!fs.existsSync(file)) continue;
    const vars = parseEnv(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(vars)) {
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      envFileSources.set(key, file);
    }
    loaded.push(file);
  }
  return loaded;
}

// ---------------------------------------------------------------------------------------
// Harness settings
// ---------------------------------------------------------------------------------------

/** Where a setting's effective value came from, highest precedence first. */
export type SettingSource = "option" | "env" | ".env" | "default";

/** Explicit settings (runAgent options / CLI flags). Undefined means "not set here". */
export interface SettingOverrides {
  contextLimit?: number;
  compactThreshold?: number;
  recentBudget?: number;
  compactModel?: string;
  coverageCheck?: boolean;
  coverageFooter?: boolean;
  maxSteps?: number;
}

export interface HarnessConfig {
  contextLimit: number;
  compactThreshold: number;
  recentBudget: number;
  /** Model for Level 1 descriptions and Level 2 summaries; defaults to the main model. */
  compactModel: string | undefined;
  coverageCheck: boolean;
  coverageFooter: boolean;
  maxSteps: number;
  sources: Record<keyof SettingOverrides, SettingSource>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ENV_NAMES: Record<keyof SettingOverrides, string> = {
  contextLimit: "CONTEXT_LIMIT",
  compactThreshold: "COMPACT_THRESHOLD",
  recentBudget: "RECENT_BUDGET",
  compactModel: "COMPACT_MODEL",
  coverageCheck: "COVERAGE_CHECK",
  coverageFooter: "COVERAGE_FOOTER",
  maxSteps: "MAX_STEPS",
};

export const DEFAULTS = {
  contextLimit: 100_000,
  compactThreshold: 0.7,
  /** RECENT_BUDGET defaults to this fraction of the context limit. */
  recentBudgetFraction: 0.4,
  coverageCheck: true,
  coverageFooter: true,
  maxSteps: 20,
} as const;

/** Resolve settings: options > process env > .env files > defaults. Throws ConfigError on bad values. */
export function resolveConfig(overrides: SettingOverrides = {}, env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const sources = {} as HarnessConfig["sources"];
  const where = (key: keyof SettingOverrides) => {
    const name = ENV_NAMES[key];
    return envFileSources.has(name) ? `${name} in ${envFileSources.get(name)}` : name;
  };
  const pick = <T>(key: keyof SettingOverrides, parse: (raw: string, label: string) => T, fallback: T): T => {
    const option = overrides[key];
    if (option !== undefined) {
      sources[key] = "option";
      return parse(String(option), `option ${key}`);
    }
    const raw = env[ENV_NAMES[key]];
    if (raw !== undefined && raw.trim() !== "") {
      sources[key] = envFileSources.has(ENV_NAMES[key]) ? ".env" : "env";
      return parse(raw.trim(), where(key));
    }
    sources[key] = "default";
    return fallback;
  };
  const number = (min: number, max: number, integer: boolean) => (raw: string, label: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      throw new ConfigError(`${label}="${raw}" is not ${integer ? "an integer" : "a number"}`);
    }
    if (n < min || n > max) throw new ConfigError(`${label}=${raw} is out of range (${min}–${max})`);
    return n;
  };
  const onOff = (raw: string, label: string) => {
    const v = raw.toLowerCase();
    if (["on", "true", "1", "yes"].includes(v)) return true;
    if (["off", "false", "0", "no"].includes(v)) return false;
    throw new ConfigError(`${label}="${raw}" must be on or off`);
  };

  const contextLimit = pick("contextLimit", number(2_000, 10_000_000, true), DEFAULTS.contextLimit);
  const compactThreshold = pick("compactThreshold", number(0.1, 0.95, false), DEFAULTS.compactThreshold);
  const recentBudget = pick(
    "recentBudget",
    number(1, contextLimit, true),
    Math.floor(contextLimit * DEFAULTS.recentBudgetFraction),
  );
  const compactModel = pick<string | undefined>("compactModel", (raw) => raw, undefined);
  const coverageCheck = pick("coverageCheck", onOff, DEFAULTS.coverageCheck);
  const coverageFooter = pick("coverageFooter", onOff, DEFAULTS.coverageFooter);
  const maxSteps = pick("maxSteps", number(1, 500, true), DEFAULTS.maxSteps);
  return { contextLimit, compactThreshold, recentBudget, compactModel, coverageCheck, coverageFooter, maxSteps, sources };
}

/** One-line "NAME=value (source)" summary of the effective settings. */
export function describeConfig(config: HarnessConfig, mainModel: string | undefined): string {
  const show = (key: keyof SettingOverrides, value: unknown) => `${ENV_NAMES[key]}=${value} (${config.sources[key]})`;
  return [
    show("contextLimit", config.contextLimit),
    show("compactThreshold", config.compactThreshold),
    show("recentBudget", config.recentBudget),
    show("compactModel", config.compactModel ?? `${mainModel ?? "main model"}`),
    show("coverageCheck", config.coverageCheck ? "on" : "off"),
    show("coverageFooter", config.coverageFooter ? "on" : "off"),
    show("maxSteps", config.maxSteps),
  ].join(" ");
}

/** package.json version plus the git commit of the harness checkout, if available. */
export function harnessVersion(): { version: string; commit: string | null } {
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    // ignore
  }
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // not a git checkout
  }
  return { version, commit };
}
