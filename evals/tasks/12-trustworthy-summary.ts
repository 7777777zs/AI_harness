import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

/**
 * Regression for "confidently wrong after compaction": each file's real definitions sit in
 * the MIDDLE of ~6-8k chars of prose, so a head/tail-only view misses them; agent.py ends
 * with a decoy event name ("chat_event") that looks like a method; tests/ is easy to skip.
 */

const TARGET_METHODS = ["ask", "stream", "_inputs", "_remember"];

const PROSE = [
  "This module is part of a small analytics assistant that answers questions about uploaded datasets.",
  "The design favours explicit data flow over hidden global state, so every dependency is passed in by the caller.",
  "Configuration is read once at start-up and treated as immutable afterwards, which keeps behaviour predictable.",
  "Error handling follows a simple rule: fail loudly during development and degrade gracefully in production.",
  "Logging is structured, and every record carries a request identifier so traces can be stitched together later.",
  "Performance matters less than clarity here; the hot paths are measured before anything clever is attempted.",
  "Backwards compatibility with the previous release is kept for one minor version, then the old paths are removed.",
  "Contributors should keep functions small, name things for what they mean, and document surprising decisions.",
];

function prose(seed: number, chars: number, prefix: string): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${prefix}${PROSE[(i + seed) % PROSE.length]} (note ${seed}.${i})\n`;
  return out;
}

/** Build a file: long header prose, the real code in the middle, long trailer prose. */
function pyFile(seed: number, title: string, code: string, trailer = ""): string {
  return (
    `"""${title}\n\n${prose(seed, 2_600, "")}"""\n\nimport json\nimport logging\n\nlog = logging.getLogger(__name__)\n\n\n` +
    `${code}\n\n` +
    `# ---------------------------------------------------------------------------\n` +
    `# Maintenance notes\n` +
    prose(seed + 3, 2_600, "# ") +
    trailer
  );
}

const FILES: Record<string, string> = {
  "app/agent.py": pyFile(
    1,
    "Insight agent: answers analytics questions with the language model and keeps a short memory.",
    `class InsightAgent:
    """Answers questions about a dataset, keeping a rolling memory of the conversation."""

    def __init__(self, llm, store, max_memory=20):
        self.llm = llm
        self.store = store
        self.max_memory = max_memory
        self.memory = []

    def ask(self, question):
        """Answer one question and remember the exchange."""
        answer = self.llm.complete(self._inputs(question))
        self._remember(question, answer)
        return answer

    async def stream(self, question):
        """Yield the answer in chunks as the model produces it."""
        chunks = []
        async for chunk in self.llm.stream(self._inputs(question)):
            chunks.append(chunk)
            yield chunk
        self._remember(question, "".join(chunks))

    def _inputs(self, question):
        context = self.store.describe()
        history = "\\n".join(f"Q: {q}\\nA: {a}" for q, a in self.memory)
        return f"{context}\\n{history}\\nQ: {question}\\nA:"

    def _remember(self, question, answer):
        self.memory.append((question, answer))
        del self.memory[:-self.max_memory]`,
    `
# Telemetry: the web UI subscribes to these event names; they are strings, not methods.
EVENTS = {
    "chat_event": "ui.chat.message",
    "error_event": "ui.error",
}
`,
  ),
  "app/db.py": pyFile(
    2,
    "Database access: a thin wrapper around SQLite used by the agent's data store.",
    `class Database:
    """Owns one SQLite connection."""

    def __init__(self, path):
        self.path = path
        self.conn = None

    def connect(self):
        import sqlite3
        self.conn = sqlite3.connect(self.path)
        return self.conn

    def query(self, sql, params=()):
        return self.conn.execute(sql, params).fetchall()

    def close(self):
        if self.conn is not None:
            self.conn.close()


def get_conn(path=":memory:"):
    db = Database(path)
    db.connect()
    return db`,
  ),
  "app/main.py": pyFile(
    3,
    "Application entry point: builds the web app and starts the HTTP server.",
    `def create_app(config):
    """Wire the database, the agent and the routes together."""
    from app.db import get_conn
    from app.agent import InsightAgent
    db = get_conn(config["db_path"])
    return {"db": db, "agent": InsightAgent(config["llm"], db)}


def run_server(app, port=8000):
    log.info("listening on %s", port)
    return app, port`,
  ),
  "app/prompts.py": pyFile(
    4,
    "Prompt templates used when talking to the language model.",
    `SYSTEM_PROMPT = "You are a careful analytics assistant."


def build_prompt(context, question):
    return f"{SYSTEM_PROMPT}\\n{context}\\nQuestion: {question}"


def format_history(pairs):
    return "\\n".join(f"Q: {q}\\nA: {a}" for q, a in pairs)`,
  ),
  "tests/test_agent.py": pyFile(
    5,
    "Tests for the insight agent.",
    `def test_ask_returns_answer(fake_llm, fake_store):
    from app.agent import InsightAgent
    agent = InsightAgent(fake_llm, fake_store)
    assert agent.ask("How many rows?") == fake_llm.answer


def test_memory_is_bounded(fake_llm, fake_store):
    from app.agent import InsightAgent
    agent = InsightAgent(fake_llm, fake_store, max_memory=2)
    for i in range(5):
        agent.ask(f"q{i}")
    assert len(agent.memory) == 2`,
  ),
  "tests/test_db.py": pyFile(
    6,
    "Tests for the database wrapper.",
    `def test_query_roundtrip():
    from app.db import get_conn
    db = get_conn()
    db.query("create table t (x int)")
    db.query("insert into t values (1)")
    assert db.query("select x from t") == [(1,)]`,
  ),
};

const TEST_FILES = ["test_agent.py", "test_db.py"];
const SKIP_WORDS = /skip|not (?:been )?(?:read|review|cover|examin|inspect|open)|unread|did(?: not|n['’]t) (?:read|review|cover|look)|have(?: not|n['’]t) (?:read|review)|omitted|excluded|beyond the scope/i;

/** File-path-like tokens in the text. */
function pathTokens(text: string): string[] {
  return [...text.matchAll(/[\w.\/\\-]+\.(?:py|js|ts|md|txt|json|toml|cfg|ini|ya?ml)\b/g)].map((m) => m[0]!);
}

export const task: EvalTask = {
  id: "trustworthy-summary",
  description: "Summarize a repo whose definitions sit mid-file, with a decoy name and a skippable tests/ dir",
  prompt:
    "Describe the purpose of each source file in this project in one sentence, and list the methods of the InsightAgent class. " +
    "Read the files one at a time.",
  contextLimit: 8_000,
  compactThreshold: 0.7,
  setup(dir) {
    for (const [p, content] of Object.entries(FILES)) write(dir, p, content);
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

    // 1. The InsightAgent methods, looked for in the text around the first mention of the class.
    const at = text.indexOf("InsightAgent");
    const window = at === -1 ? "" : text.slice(at, at + 1_200);
    const missing = TARGET_METHODS.filter((m) => !new RegExp(`(^|[^\\w])${m}\\b`).test(window));
    if (missing.length) problems.push(`methods not listed: ${missing.join(", ")}`);

    // 2. The decoy: no invented "chat" method, and chat_event not presented as a method.
    const method = TARGET_METHODS.join("|");
    const listedWithMethods = new RegExp(
      `\\b(?:${method})\`?(?:\\(\\))?\\s*(?:,|and|\\n\\s*(?:[-*•]|\\d+[.)]))\\s*\`?chat(?:_event)?\\b|` +
        `\\bchat(?:_event)?\`?(?:\\(\\))?\\s*(?:,|and)\\s*\`?(?:${method})\\b`,
      "i",
    );
    const claimsChat =
      /(\.|`)chat\b|\bchat\s*\(|\bchat(?:_event)?`?\s+method/i.test(text) ||
      listedWithMethods.test(text) ||
      window.split("\n").some((line) => /^\s*(?:[-*•]|\d+[.)])\s*`?chat(?:_event)?\b/i.test(line)) ||
      /\bchat_event\s*\(|\.chat_event\b/.test(text);
    if (claimsChat) problems.push("claims chat/chat_event is a method");

    // 3. Every referenced file path must exist (as a path or as a file name).
    const real = Object.keys(FILES);
    const bogus = pathTokens(text).filter((tok) => {
      const norm = tok.replace(/\\/g, "/").replace(/^\.\//, "");
      return !real.includes(norm) && !real.some((r) => path.posix.basename(r) === norm) && !fs.existsSync(path.join(dir, norm));
    });
    if (bogus.length) problems.push(`references non-existent files: ${[...new Set(bogus)].join(", ")}`);

    // 4. Coverage: tests/ described, or explicitly reported as skipped.
    const undescribed = TEST_FILES.filter((f) => !text.includes(f));
    if (undescribed.length && !(/\btests?\b/i.test(text) && SKIP_WORDS.test(text))) {
      problems.push(`tests/ not described and not reported as skipped (${undescribed.join(", ")})`);
    }
    return problems.length ? fail(problems.join("; ")) : pass();
  },
};
