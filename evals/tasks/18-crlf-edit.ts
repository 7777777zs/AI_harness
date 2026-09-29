import fs from "node:fs";
import path from "node:path";
import type { EvalTask } from "../types.js";
import { fail, pass } from "../helpers.js";

/**
 * Edit one value in a Windows-style (CRLF) file. The check compares bytes: the target line must
 * change, and every other byte — including every "\r\n" — must stay exactly as it was.
 */

const LINES = [
  "; Service configuration (Windows line endings)",
  "[general]",
  "name = inventory-api",
  "environment = production",
  "",
  "[logging]",
  "log_level = info",
  "log_file = C:\\logs\\inventory.log",
  "; log_level_override = debug  (not used)",
  "max_log_size_mb = 50",
  "",
  "[network]",
  "host = 0.0.0.0",
  "port = 8080",
  "timeout_seconds = 30",
];
const ORIGINAL = LINES.join("\r\n") + "\r\n";
const EXPECTED = ORIGINAL.replace("log_level = info\r\n", "log_level = debug\r\n");

export const task: EvalTask = {
  id: "crlf-edit",
  description: "Change one value in a CRLF file; every other byte, including line endings, must be unchanged",
  prompt: "In service.ini, change the log level from info to debug. Do not change anything else in the file.",
  setup(dir) {
    // Written as raw bytes so the CRLF endings are exactly what the check expects.
    fs.writeFileSync(path.join(dir, "service.ini"), Buffer.from(ORIGINAL, "utf8"));
  },
  check(dir) {
    const actual = fs.readFileSync(path.join(dir, "service.ini"));
    const expected = Buffer.from(EXPECTED, "utf8");
    if (actual.equals(expected)) return pass();
    const text = actual.toString("utf8");
    if (!text.includes("log_level = debug")) return fail("log_level was not changed to debug");
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
    if (lf > 0) return fail(`line endings changed: ${crlf} CRLF, ${lf} bare LF (expected ${LINES.length} CRLF)`);
    const i = [...actual].findIndex((b, k) => b !== expected[k]);
    return fail(`bytes differ from the expected file at offset ${i} (${actual.length} vs ${expected.length} bytes)`);
  },
};
