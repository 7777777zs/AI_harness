// Loaded before every test file (see the "test" script): point HARNESS_HOME at a temp
// directory so tests never write logs into the real ~/.harness.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HARNESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-harness-home-"));
process.on("exit", () => fs.rmSync(process.env.HARNESS_HOME!, { recursive: true, force: true }));
// The bundled skills would change every run's system prompt and tools; tests that need
// skills turn them on explicitly (skillsEnabled: true).
process.env.SKILLS = "off";
