// Minimal glob-to-RegExp conversion, so there is no glob dependency (Node's path.matchesGlob
// and fs.glob are not available on every Node version allowed by package.json "engines").
//
// Supported: `*` (within one path segment), `**` (any number of segments), `?`, `[abc]`,
// `[a-z]`, `[!abc]`, `{a,b}`. Paths use "/"; backslashes in the pattern are treated as "/".
// A pattern without "/" matches the file name at any depth ("*.py" == "**/*.py"); a pattern
// with "/" is anchored at the search root. Matching is case-insensitive on Windows only.

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

export function globToRegExp(glob: string, caseInsensitive = process.platform === "win32"): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!g) throw new Error("Empty glob pattern");
  const anchored = g.replace(/\/+$/, "").includes("/");
  let re = "";
  let braces = 0;
  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === "*") {
      let j = i;
      while (g[j] === "*") j++;
      if (j - i >= 2) {
        const segStart = i === 0 || g[i - 1] === "/";
        if (segStart && g[j] === "/") {
          re += "(?:[^/]*/)*"; // "**/": zero or more directories
          i = j + 1;
          continue;
        }
        if (segStart && j === g.length) {
          re += ".*"; // trailing "**": everything below
          i = j;
          continue;
        }
      }
      re += "[^/]*";
      i = j;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const close = g.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        i++;
        continue;
      }
      let body = g.slice(i + 1, close);
      const negate = body[0] === "!" || body[0] === "^";
      if (negate) body = body.slice(1);
      body = body.replace(/[\\\]\[^]/g, "\\$&");
      re += negate ? `[^/${body}]` : `[${body}]`;
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      braces++;
      re += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (ch === "," && braces > 0) {
      re += "|";
    } else {
      re += ch.replace(REGEX_SPECIAL, "\\$&");
    }
    i++;
  }
  if (braces > 0) throw new Error(`Invalid glob pattern "${glob}": unclosed "{"`);
  // A trailing "/" means "directory"; the tools match files, so allow anything below it.
  if (re.endsWith("\\/")) re += ".*";
  return new RegExp(`^${anchored ? "" : "(?:[^/]*/)*"}${re}$`, caseInsensitive ? "i" : "");
}
