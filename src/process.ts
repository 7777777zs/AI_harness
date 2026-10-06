// Process-tree helpers: killing a process and everything it started, and a registry of
// long-lived child processes (MCP servers) that must not outlive the harness, even when the
// run ends with an error or the user presses Ctrl+C.
import { execFile, spawnSync } from "node:child_process";

/**
 * Kill a process and everything it started. On Windows, killing cmd.exe (or npx.cmd) leaves
 * its children running, so the whole tree is killed with taskkill /T. Elsewhere the child runs
 * in its own process group (spawned detached) and the group is killed.
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Windows only: every descendant of `pid`, from one process-table query. Used at shutdown to
 * find processes (e.g. Chrome) whose parent may exit before they do. Elsewhere returns [],
 * because the process group already covers them.
 */
export function descendants(pid: number): Promise<number[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        const children = new Map<number, number[]>();
        for (const line of stdout.split(/\r?\n/)) {
          const [child, parent] = line.trim().split(/\s+/).map(Number);
          if (!child || parent === undefined || Number.isNaN(parent) || child === parent) continue;
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent)!.push(child);
        }
        const found = new Set<number>();
        const stack = [pid];
        while (stack.length) {
          for (const child of children.get(stack.pop()!) ?? []) {
            if (found.has(child) || child === pid) continue;
            found.add(child);
            stack.push(child);
          }
        }
        resolve([...found]);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------
// Registry of long-lived children
// ---------------------------------------------------------------------------------------

/** Root pid -> graceful async shutdown. */
const live = new Map<number, () => Promise<void>>();

/** Track a long-lived child; returns a function that stops tracking it. */
export function registerChild(pid: number, shutdown: () => Promise<void>): () => void {
  live.set(pid, shutdown);
  return () => void live.delete(pid);
}

export function liveChildren(): number[] {
  return [...live.keys()];
}

/** Last resort (e.g. in an `exit` handler, where only synchronous work runs): kill every tree. */
export function killAllSync(): void {
  for (const pid of live.keys()) killTree(pid);
  live.clear();
}

/** Run on shutdown after the children are gone (e.g. the eval runner's sandboxes and results). */
const cleanups: (() => Promise<void> | void)[] = [];
/** Run first on shutdown, before anything waits (e.g. the eval runner stops taking results). */
const interruptHooks: (() => void)[] = [];

export function registerCleanup(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}

export function onInterrupt(hook: () => void): void {
  interruptHooks.push(hook);
}

/**
 * Run the interrupt hooks, gracefully shut down every tracked child (killing whatever is left
 * after `timeoutMs`), then run the registered cleanups (children first: Windows can't delete a
 * process's working directory).
 */
export async function shutdownAll(timeoutMs = 5_000): Promise<void> {
  for (const hook of interruptHooks.splice(0)) {
    try {
      hook();
    } catch {
      // keep going: shutting down matters more
    }
  }
  const pending = [...live.values()].map((shutdown) => shutdown().catch(() => {}));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(pending), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
  killAllSync();
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
      // keep going: the other cleanups still matter
    }
  }
}

let handlersInstalled = false;

/**
 * For the CLI and the eval runner: on Ctrl+C (SIGINT), SIGTERM or a closed console (SIGHUP),
 * shut down tracked children before exiting; on any exit, kill what is still tracked.
 */
export function installShutdownHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onSignal = (signal: NodeJS.Signals, code: number) => {
    process.once(signal, () => process.exit(code)); // a second signal exits immediately
    void shutdownAll().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => onSignal("SIGINT", 130));
  process.once("SIGTERM", () => onSignal("SIGTERM", 143));
  process.once("SIGHUP", () => onSignal("SIGHUP", 129));
  process.on("exit", killAllSync);
}
