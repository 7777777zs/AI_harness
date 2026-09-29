import { spawn } from "node:child_process";
import { DENIED, type Tool } from "../types.js";
import { killTree } from "../process.js";
import { requireString } from "./util.js";

export const TIMEOUT_MS = 30_000;
/** Output beyond this is dropped while collecting (the agent truncates results anyway). */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Run a command with the platform shell; resolves with status, stdout and stderr. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const collect = (append: (s: string) => void) => (chunk: Buffer) => {
      if (stdout.length + stderr.length < MAX_BUFFER) append(chunk.toString("utf8"));
    };
    child.stdout!.on("data", collect((s) => (stdout += s)));
    child.stderr!.on("data", collect((s) => (stderr += s)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const status = timedOut
        ? `killed: timed out after ${timeoutMs / 1000}s (process tree terminated)`
        : code !== null
          ? `exit code: ${code}`
          : `killed: ${signal}`;
      resolve(`${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    });
  });
}

/** The run_shell tool with a given timeout (tests use a short one). */
export function makeRunShell(timeoutMs = TIMEOUT_MS): Tool {
  return {
    name: "run_shell",
    description: `Run a shell command in the working directory (${
      process.platform === "win32" ? "cmd.exe on Windows" : "/bin/sh"
    }). Times out after ${timeoutMs / 1000} seconds. Returns exit code, stdout and stderr.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const command = requireString(args, "command");
      if (!(await ctx.confirm(`run_shell -> ${command}`))) return DENIED;
      return runCommand(command, ctx.cwd, timeoutMs);
    },
  };
}

export const runShell = makeRunShell();
