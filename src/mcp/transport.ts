// MCP stdio transport over a child process the harness controls. The SDK's own stdio transport
// only terminates the root process on close; on Windows that root is cmd.exe (for npx.cmd), so
// node and any browser it started would be left running. Here the whole tree is shut down.
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { descendants, isAlive, killTree, registerChild } from "../process.js";

/** How long a server gets to exit by itself after its stdin is closed. */
export const GRACEFUL_EXIT_MS = 3_000;
const STDERR_LINES = 20;

export interface ProcessTransportParams {
  command: string;
  args: string[];
  /** Added to the SDK's minimal default environment (the harness's API key is not passed on). */
  env: Record<string, string>;
  cwd: string;
}

export class ProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrLines: string[] = [];
  private stderrPartial = "";
  private unregister: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private notifiedClose = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly params: ProcessTransportParams) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The last lines the server wrote to stderr (for startup failure messages). */
  stderrTail(): string {
    return [...this.stderrLines, this.stderrPartial].filter(Boolean).join("\n");
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args, {
        cwd: this.params.cwd,
        env: { ...getDefaultEnvironment(), ...this.params.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX: its own process group, so the whole group can be killed.
        detached: process.platform !== "win32",
      });
      this.child = child;
      this.exited = new Promise((r) => child.once("exit", () => r()));
      let started = false;
      child.once("error", (err) => {
        if (!started) reject(err);
        else this.onerror?.(err);
        this.notifyClose();
      });
      child.once("spawn", () => {
        started = true;
        if (child.pid !== undefined) this.unregister = registerChild(child.pid, () => this.close());
        resolve();
      });
      child.once("exit", () => {
        this.unregister?.();
        this.notifyClose();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.drain();
      });
      child.stdout!.on("error", (err) => this.onerror?.(err));
      child.stdin!.on("error", (err) => this.onerror?.(err));
      child.stderr!.on("data", (chunk: Buffer) => this.keepStderr(chunk.toString("utf8")));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || this.closing) return reject(new Error("MCP server is not running"));
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  /**
   * Close stdin so the server can shut down cleanly (e.g. close its browser); after
   * GRACEFUL_EXIT_MS, kill the tree. On Windows, descendants whose parent already exited are
   * found through a process-table snapshot taken at the start of the shutdown.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    const pid = child?.pid;
    if (!child || pid === undefined) return this.notifyClose();
    const snapshot = descendants(pid);
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), GRACEFUL_EXIT_MS))),
    ]);
    clearTimeout(timer);
    if (!graceful || process.platform !== "win32") killTree(pid);
    for (const p of await snapshot) if (isAlive(p)) killTree(p);
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 1_000).unref())]);
    this.unregister?.();
    this.notifyClose();
  }

  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  private keepStderr(text: string): void {
    const lines = (this.stderrPartial + text).split(/\r?\n/);
    this.stderrPartial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.stderrLines.push(line);
    this.stderrLines.splice(0, Math.max(0, this.stderrLines.length - STDERR_LINES));
    if (this.stderrPartial.length > 2_000) this.stderrPartial = this.stderrPartial.slice(-2_000);
  }

  private notifyClose(): void {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    this.onclose?.();
  }
}
