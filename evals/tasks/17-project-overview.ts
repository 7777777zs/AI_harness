import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

/**
 * Whole-project overview under a tight context: ~30 tracked files (too many to keep in an
 * 8k context), FastAPI routes defined inside create_app(). The answer must either cover
 * every source file or say explicitly which ones it did not cover, and must not invent paths.
 */

const MODULES: [string, string][] = [
  ["app/main.py", "Application factory: builds the FastAPI app and registers the HTTP routes."],
  ["app/config.py", "Settings loaded from environment variables with typed defaults."],
  ["app/db.py", "Database session management on top of SQLAlchemy."],
  ["app/models/user.py", "User account model with password hashing."],
  ["app/models/document.py", "Uploaded document model with metadata and chunk references."],
  ["app/models/chat.py", "Chat session and message models."],
  ["app/services/search.py", "Hybrid keyword and vector search over document chunks."],
  ["app/services/embedding.py", "Computes and caches text embeddings in batches."],
  ["app/services/ranking.py", "Re-ranks search hits with a cross-encoder score."],
  ["app/services/summarizer.py", "Summarizes documents into short abstracts."],
  ["app/services/cache.py", "Small TTL cache used by the services."],
  ["app/routers/admin.py", "Admin-only endpoints for reindexing and stats."],
  ["app/routers/uploads.py", "Upload endpoints that accept and store documents."],
  ["app/utils/text.py", "Text normalization and chunking helpers."],
  ["app/utils/time.py", "Timezone-aware timestamp helpers."],
  ["app/utils/ids.py", "Sortable unique id generation."],
  ["scripts/seed_db.py", "Seeds a development database with sample documents."],
  ["scripts/export_csv.py", "Exports chat transcripts to CSV."],
  ["tests/test_main.py", "Tests for the HTTP routes."],
  ["tests/test_search.py", "Tests for hybrid search."],
  ["tests/test_ranking.py", "Tests for re-ranking."],
  ["tests/test_cache.py", "Tests for the TTL cache."],
  ["tests/test_db.py", "Tests for database sessions."],
  ["tests/conftest.py", "Shared pytest fixtures."],
];
const ROUTES = ["/chat", "/ask", "/documents", "/health"];

const MAIN_BODY = `def create_app(settings=None):
    """Build the application and register every route."""
    from fastapi import FastAPI
    app = FastAPI(title="docs-assistant")

    def _log_startup():  # plain helper, not a route
        log.info("starting")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/chat")
    async def chat(message: dict):
        return {"reply": message.get("text", "")}

    @app.post("/ask")
    async def ask(question: dict):
        return {"answer": question.get("q", "")}

    @app.get("/documents")
    def list_documents(limit: int = 20):
        return {"items": [], "limit": limit}

    _log_startup()
    return app`;

const PADDING = [
  "Keep functions small and name them for what they mean.",
  "Configuration is read once at start-up and passed in explicitly.",
  "Errors are raised early in development and logged with a request id in production.",
  "Public functions document their arguments and return values.",
];

function pad(seed: number, chars: number): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `# ${PADDING[(seed + i) % PADDING.length]} (${seed}.${i})\n`;
  return s;
}

function moduleSource(p: string, purpose: string, i: number): string {
  const base = path.posix.basename(p, ".py");
  const body =
    p === "app/main.py"
      ? MAIN_BODY
      : `def ${base}_entry(value):\n    """${purpose}"""\n    return value\n\n\ndef _${base}_helper(items):\n    return [x for x in items if x]`;
  return `"""${purpose}"""\n\nimport logging\n\nlog = logging.getLogger(__name__)\n\n${pad(i, 900)}\n${body}\n\n${pad(i + 7, 1_200)}`;
}

const SKIP_WORDS = /skip|not (?:been )?(?:read|review|cover|examin|inspect|open|describ)|unread|did(?: not|n['’]t) (?:read|review|cover|look|describe)|have(?: not|n['’]t) (?:read|review|cover)|omitted|excluded|beyond the scope/i;

function pathTokens(text: string): string[] {
  return [...text.matchAll(/[\w.\/\\-]+\.(?:py|js|ts|md|txt|json|toml|cfg|ini|ya?ml)\b/g)].map((m) => m[0]!);
}

export const task: EvalTask = {
  id: "project-overview",
  description: "Overview of a ~30-file project under an 8k context: cover every source file or say what was skipped",
  prompt:
    "Give an overview of this project: list each source file with a one-line description of its purpose, " +
    "and list the HTTP routes the application exposes.",
  contextLimit: 8_000,
  compactThreshold: 0.7,
  maxSteps: 30,
  setup(dir) {
    MODULES.forEach(([p, purpose], i) => write(dir, p, moduleSource(p, purpose, i)));
    for (const init of ["app", "app/models", "app/services", "app/routers", "app/utils"]) write(dir, `${init}/__init__.py`, "");
    write(dir, "README.md", "# docs-assistant\n\nAsk questions about uploaded documents.\n");
    write(dir, "pyproject.toml", '[project]\nname = "docs-assistant"\nversion = "0.3.0"\n');
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (git("init", "-q").status === 0) {
      git("add", "-A");
      git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
    }
  },
  check(dir, result) {
    if (result.stopReason !== "done") return fail(`run ended with ${result.stopReason}`);
    const text = result.finalText ?? "";
    const problems: string[] = [];

    const missingRoutes = ROUTES.filter((r) => !new RegExp(`${r.replace("/", "\\/")}\\b`).test(text));
    if (missingRoutes.length) problems.push(`routes not listed: ${missingRoutes.join(", ")}`);

    // Coverage: every source module is described, or the answer explicitly says what it skipped
    // (a skip statement plus a mention of each uncovered file or its directory).
    const uncovered = MODULES.map(([p]) => p).filter((p) => !text.includes(path.posix.basename(p)));
    if (uncovered.length) {
      const unmentioned = uncovered.filter((p) => !text.includes(p) && !text.includes(path.posix.dirname(p)));
      if (!SKIP_WORDS.test(text)) problems.push(`${uncovered.length} source files not described and no skip statement`);
      else if (unmentioned.length) problems.push(`skipped files not identified: ${unmentioned.join(", ")}`);
    }

    // A reference is fine if it is a real file, or a suffix of one ("routers/admin.py", "__init__.py").
    const realFiles = (fs.readdirSync(dir, { recursive: true }) as string[])
      .map((p) => p.split(path.sep).join("/"))
      .filter((p) => !p.startsWith(".git/") && fs.statSync(path.join(dir, p)).isFile());
    const bogus = pathTokens(text).filter((tok) => {
      const norm = tok.replace(/\\/g, "/").replace(/^\.\//, "");
      return !realFiles.some((p) => p === norm || p.endsWith(`/${norm}`));
    });
    if (bogus.length) problems.push(`references non-existent files: ${[...new Set(bogus)].join(", ")}`);
    return problems.length ? fail(problems.join("; ")) : pass();
  },
};
