// Runs the eval runner in this process and emits SIGINT after SIGINT_AFTER_MS, the way Ctrl+C
// reaches it (on Windows a parent can't send SIGINT to a child). Arguments go to the runner.
setTimeout(() => process.emit("SIGINT"), Number(process.env.SIGINT_AFTER_MS ?? 3000)).unref();
await import("../../evals/run.ts");
