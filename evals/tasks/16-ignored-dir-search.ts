import type { EvalTask } from "../types.js";
import { fail, lines, pass, read, write } from "../helpers.js";

const MARKER = "TODO(perf)";
const MODULES = ["auth", "cart", "catalog", "checkout", "search", "profile", "orders", "payments", "inventory", "reviews", "shipping", "email"];
/** Project files that contain the marker. */
const EXPECTED = ["src/cart/total.js", "src/catalog/list.js", "src/search/index.js", "src/orders/history.js"];

function sourceFile(name: string, withMarker: boolean): string {
  const body = [
    `// ${name}`,
    `export function run(input) {`,
    `  const items = [...input];`,
    ...(withMarker ? [`  // ${MARKER}: this sort runs on every request; cache it`] : []),
    `  items.sort((a, b) => a.id - b.id);`,
    `  return items;`,
    `}`,
  ];
  return body.join("\n") + "\n";
}

export const task: EvalTask = {
  id: "ignored-dir-search",
  description: "Find files containing a marker in a project with a large node_modules and a gitignored directory",
  prompt:
    `Which files in this project contain the marker "${MARKER}"? Only the project's own source counts: dependencies ` +
    "in node_modules and anything excluded by .gitignore are not part of the project. Write the relative paths, " +
    "one per line, to perf-todos.txt, and list them in your final answer.",
  setup(dir) {
    write(dir, ".gitignore", "generated/\n*.log\n");
    write(dir, "package.json", '{ "name": "shop", "private": true }\n');
    for (const m of MODULES) {
      for (const f of ["index.js", "total.js", "list.js", "history.js"]) {
        const rel = `src/${m}/${f}`;
        if (f !== "index.js" && !EXPECTED.includes(rel) && (m.length + f.length) % 3 !== 0) continue;
        write(dir, rel, sourceFile(rel, EXPECTED.includes(rel)));
      }
    }
    // A large fake node_modules where many files contain the marker.
    for (let p = 0; p < 120; p++) {
      for (let f = 0; f < 10; f++) {
        write(dir, `node_modules/pkg-${p}/lib/file-${f}.js`, sourceFile(`pkg-${p}/${f}`, f % 2 === 0));
      }
      write(dir, `node_modules/pkg-${p}/package.json`, `{ "name": "pkg-${p}" }\n`);
    }
    for (let g = 0; g < 15; g++) write(dir, `generated/api-${g}.js`, sourceFile(`generated ${g}`, true));
    write(dir, "debug.log", `${MARKER} seen in a log line\n`);
  },
  check(dir) {
    const content = read(dir, "perf-todos.txt");
    if (content === null) return fail("perf-todos.txt was not created");
    const reported = new Set(
      lines(content)
        .map((l) => l.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+.*$/, ""))
        .filter(Boolean),
    );
    const ignored = [...reported].filter((p) => /node_modules|generated\/|\.log$/.test(p));
    if (ignored.length) return fail(`reported ignored files (${ignored.length}), e.g. ${ignored[0]}`);
    const missing = EXPECTED.filter((p) => !reported.has(p));
    const extra = [...reported].filter((p) => !EXPECTED.includes(p));
    if (missing.length || extra.length) return fail(`missing: [${missing.join(", ")}]; extra: [${extra.join(", ")}]`);
    return pass();
  },
};
