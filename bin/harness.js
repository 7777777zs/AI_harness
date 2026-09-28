#!/usr/bin/env node
// Global entry point for the `harness` command (installed with `npm link`).
// Registers tsx from the harness's own node_modules, so the TypeScript sources run
// directly with no build step, regardless of the directory the user runs it from.
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");
