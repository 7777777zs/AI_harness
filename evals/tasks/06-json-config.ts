import { isDeepStrictEqual } from "node:util";
import type { EvalTask } from "../types.js";
import { fail, pass, read, write } from "../helpers.js";

const ORIGINAL = {
  name: "orders-service",
  version: "2.4.1",
  server: { host: "localhost", port: 3000, tls: false },
  database: { url: "postgres://db:5432/orders", pool: { min: 2, max: 10 } },
  features: ["audit-log", "bulk-export"],
};

export const task: EvalTask = {
  id: "json-config",
  description: "Read a JSON config, change one value, write it back as valid JSON",
  prompt: "In config.json, change the server port from 3000 to 8080. Keep every other value unchanged and keep the file valid JSON.",
  setup(dir) {
    write(dir, "config.json", JSON.stringify(ORIGINAL, null, 2) + "\n");
  },
  check(dir) {
    const content = read(dir, "config.json");
    if (content === null) return fail("config.json is missing");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return fail(`config.json is not valid JSON: ${(err as Error).message}`);
    }
    const expected = structuredClone(ORIGINAL);
    expected.server.port = 8080;
    if (!isDeepStrictEqual(parsed, expected)) return fail(`config differs from expected: ${content.replace(/\s+/g, " ").slice(0, 160)}`);
    return pass();
  },
};
