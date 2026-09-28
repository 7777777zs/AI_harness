// Locations and environment loading shared by the CLI and the eval runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Load .env files without overriding variables that are already set.
 * Precedence: process environment > ~/.harness/.env > <harness install>/.env.
 * The user's project directory is never read, so its .env can't leak into the harness.
 * Returns the files that were loaded.
 */
export function loadEnv(): string[] {
  const loaded: string[] = [];
  for (const file of [path.join(harnessHome(), ".env"), path.join(PACKAGE_ROOT, ".env")]) {
    if (!fs.existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(file);
  }
  return loaded;
}
