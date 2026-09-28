// Regex-based extraction of top-level and class-level definitions from source files.
// Deliberately simple (no parser dependency); used to put trustworthy names into
// placeholders for elided read_file results, instead of relying on a model description.

export interface ClassSymbols {
  name: string;
  methods: string[];
}

export interface Symbols {
  classes: ClassSymbols[];
  functions: string[];
}

const PY_EXT = /\.py$/i;
const JS_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
/** Constructors are noise in a summary of what a class does. */
const SKIP_METHODS = new Set(["__init__", "constructor"]);
const MAX_NAMES = 40;

export function languageOf(filePath: string): "python" | "js" | null {
  if (PY_EXT.test(filePath)) return "python";
  if (JS_EXT.test(filePath)) return "js";
  return null;
}

export function extractSymbols(filePath: string, content: string): Symbols | null {
  const lang = languageOf(filePath);
  if (lang === "python") return extractPython(content);
  if (lang === "js") return extractJs(content);
  return null;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function extractPython(content: string): Symbols {
  const out: Symbols = { classes: [], functions: [] };
  // Open scopes, innermost last. Only scopes that can contain definitions we care about.
  const scopes: { kind: "class" | "def"; indent: number; cls?: ClassSymbols }[] = [];
  let inString: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    // Skip the bodies of triple-quoted strings (docstrings can contain "def ..." prose).
    if (inString) {
      if (line.includes(inString)) inString = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = indentOf(line);
    while (scopes.length && scopes.at(-1)!.indent >= indent) scopes.pop();

    const cls = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    const fn = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    const inner = scopes.at(-1);
    if (cls) {
      // Classes inside functions are local helpers; skip them (but still track the scope).
      const record: ClassSymbols | undefined = inner?.kind === "def" ? undefined : { name: cls[1]!, methods: [] };
      if (record) out.classes.push(record);
      scopes.push({ kind: "class", indent, ...(record && { cls: record }) });
    } else if (fn) {
      if (!inner) out.functions.push(fn[1]!);
      else if (inner.kind === "class" && inner.cls && !SKIP_METHODS.has(fn[1]!)) inner.cls.methods.push(fn[1]!);
      scopes.push({ kind: "def", indent });
    }

    // Enter a triple-quoted string that does not close on this line.
    for (const q of ['"""', "'''"]) {
      const count = line.split(q).length - 1;
      if (count % 2 === 1) {
        inString = q;
        break;
      }
    }
  }
  return out;
}

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "else", "do", "try", "with", "typeof", "await", "super"]);

/** Remove string literals and line comments so braces and names inside them are ignored. */
function stripJsLine(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function extractJs(content: string): Symbols {
  const out: Symbols = { classes: [], functions: [] };
  const classes: { cls: ClassSymbols; depth: number }[] = [];
  let depth = 0;
  let inBlockComment = false;

  for (const raw of content.split(/\r?\n/)) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = stripJsLine(line).replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open !== -1) {
      line = line.slice(0, open);
      inBlockComment = true;
    }

    const inClass = classes.at(-1);
    const cls = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    const fn = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
    const arrow =
      /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(line);

    if (cls) {
      const record = { name: cls[1]!, methods: [] };
      out.classes.push(record);
      classes.push({ cls: record, depth: depth + 1 });
    } else if (depth === 0 && fn) {
      out.functions.push(fn[1]!);
    } else if (depth === 0 && arrow) {
      out.functions.push(arrow[1]!);
    } else if (inClass && depth === inClass.depth) {
      const method =
        /^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(line);
      if (method && !JS_KEYWORDS.has(method[1]!) && !SKIP_METHODS.has(method[1]!)) inClass.cls.methods.push(method[1]!);
    }

    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    while (classes.length && depth < classes.at(-1)!.depth) classes.pop();
  }
  return out;
}

/** e.g. "class InsightAgent: ask, stream, _inputs, _remember; functions: build_app, main" */
export function formatSymbols(symbols: Symbols): string {
  const parts: string[] = [];
  let names = 0;
  let omitted = 0;
  const take = (list: string[]) => {
    const room = Math.max(0, MAX_NAMES - names);
    const kept = list.slice(0, room);
    names += kept.length;
    omitted += list.length - kept.length;
    return kept;
  };
  for (const c of symbols.classes) {
    const methods = take(c.methods);
    parts.push(methods.length ? `class ${c.name}: ${methods.join(", ")}` : `class ${c.name}`);
  }
  const fns = take(symbols.functions);
  if (fns.length) parts.push(`functions: ${fns.join(", ")}`);
  if (omitted) parts.push(`(+${omitted} more)`);
  return parts.join("; ");
}
