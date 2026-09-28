import { exec } from "node:child_process";
import { DENIED, type Tool } from "../types.js";
import { requireString } from "./util.js";

const TIMEOUT_MS = 30_000;

export const runShell: Tool = {
  name: "run_shell",
  description: `Run a shell command in the working directory (${
    process.platform === "win32" ? "cmd.exe on Windows" : "/bin/sh"
  }). Times out after ${TIMEOUT_MS / 1000} seconds. Returns exit code, stdout and stderr.`,
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

    return new Promise((resolve) => {
      exec(
        command,
        { cwd: ctx.cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          let status: string;
          if (error?.killed) status = `killed: timed out after ${TIMEOUT_MS / 1000}s`;
          else if (error && typeof error.code === "number") status = `exit code: ${error.code}`;
          else if (error) status = `error: ${error.message}`;
          else status = "exit code: 0";
          resolve(`${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        },
      );
    });
  },
};
