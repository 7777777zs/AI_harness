// Terminal y/N confirmation for side-effecting tools.
import readline from "node:readline/promises";

export interface TerminalConfirm {
  confirm(summary: string): Promise<boolean>;
  close(): void;
}

/** The readline interface is created on first use and must be closed afterwards. */
export function createTerminalConfirm(): TerminalConfirm {
  let rl: readline.Interface | undefined;
  let stdinClosed = false;

  return {
    async confirm(summary) {
      console.log(`\n\x1b[35m${summary}\x1b[0m`);
      if (stdinClosed || !process.stdin.isTTY) {
        console.log("(no interactive terminal: denied)");
        return false;
      }
      if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.on("close", () => (stdinClosed = true));
      }
      const answer = await rl.question("Proceed? (y/N) ");
      return answer.trim().toLowerCase() === "y";
    },
    close() {
      rl?.close();
    },
  };
}
