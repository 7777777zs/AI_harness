// Runs the eval runner in this process and emits SIGINT the way Ctrl+C reaches it (on Windows a
// parent can't send SIGINT to a child). Arguments go to the runner.
//   SIGINT_AFTER_TEXT: emit SIGINT once the runner prints this text (e.g. a finished job's line)
//   SIGINT_AFTER_MS:   otherwise (or as a fallback) emit it after this many milliseconds
let sent = false;
const sigint = () => {
  if (sent) return;
  sent = true;
  process.emit("SIGINT");
};
const after = process.env.SIGINT_AFTER_TEXT;
if (after) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (String(chunk).includes(after)) setTimeout(sigint, 200);
    return write(chunk, ...rest);
  };
}
setTimeout(sigint, Number(process.env.SIGINT_AFTER_MS ?? 3000)).unref();
await import("../../evals/run.ts");
