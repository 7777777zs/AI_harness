// A file's text as lines that remember their own line ending, plus its BOM. read_file shows the
// LF-normalized text, edit_file matches against it, and both edit_file and write_file write back
// in the file's own style, so untouched lines keep their exact bytes.

export type Eol = "" | "\n" | "\r\n";

export interface Line {
  text: string;
  /** "" only for a last line without a trailing newline. */
  eol: Eol;
}

export interface TextFile {
  bom: boolean;
  lines: Line[];
}

const BOM = "﻿";

/** Split into lines (line breaks are \r\n or \n; a lone \r stays part of the text). */
export function parseText(raw: string): TextFile {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const lines: Line[] = [];
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf("\n", i);
    if (nl === -1) {
      lines.push({ text: body.slice(i), eol: "" });
      break;
    }
    const crlf = nl > i && body[nl - 1] === "\r";
    lines.push({ text: body.slice(i, crlf ? nl - 1 : nl), eol: crlf ? "\r\n" : "\n" });
    i = nl + 1;
  }
  return { bom, lines };
}

/** The text as the model sees it: no BOM, every line break is "\n". */
export function toLF(lines: Line[]): string {
  return lines.map((l) => l.text + (l.eol ? "\n" : "")).join("");
}

export function serialize(file: TextFile): string {
  return (file.bom ? BOM : "") + file.lines.map((l) => l.text + l.eol).join("");
}

/** The file's prevailing line ending ("\n" for files without line breaks and for ties). */
export function dominantEol(lines: Line[]): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.eol === "\r\n") crlf++;
    else if (l.eol === "\n") lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Normalize text sent by the model (which may contain \r\n) to "\n". */
export const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

/** LF text -> lines using `eol` for every line break. */
export function linesFromLF(text: string, eol: "\n" | "\r\n"): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const lines: Line[] = parts.slice(0, -1).map((t) => ({ text: t, eol }));
  const last = parts.at(-1)!;
  if (last !== "") lines.push({ text: last, eol: "" });
  return lines;
}

export interface Replacement {
  /** Offset in the LF text. */
  start: number;
  end: number;
  text: string;
}

/**
 * Apply replacements (given against the LF text, ascending, non-overlapping) to the file. Only
 * the lines a replacement touches are rewritten, using the file's dominant line ending; all
 * other lines keep their original ending, and the BOM is kept.
 */
export function applyReplacements(file: TextFile, replacements: Replacement[]): TextFile {
  const lf = toLF(file.lines);
  const starts: number[] = [];
  let off = 0;
  for (const l of file.lines) {
    starts.push(off);
    off += l.text.length + (l.eol ? 1 : 0);
  }
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const eol = dominantEol(file.lines);

  // Group replacements into line spans; replacements sharing a line share a span.
  const spans: { first: number; last: number; reps: Replacement[] }[] = [];
  for (const r of replacements) {
    const first = file.lines.length ? lineOf(r.start) : 0;
    const last = file.lines.length ? lineOf(Math.max(r.start, r.end - 1)) : 0;
    const prev = spans.at(-1);
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.reps.push(r);
    } else {
      spans.push({ first, last, reps: [r] });
    }
  }

  const out: Line[] = [];
  let next = 0;
  for (const span of spans) {
    out.push(...file.lines.slice(next, span.first));
    const regionStart = file.lines.length ? starts[span.first]! : 0;
    const regionEnd = span.last + 1 < file.lines.length ? starts[span.last + 1]! : lf.length;
    let region = "";
    let cursor = regionStart;
    for (const r of span.reps) {
      region += lf.slice(cursor, r.start) + r.text;
      cursor = r.end;
    }
    region += lf.slice(cursor, regionEnd);
    out.push(...linesFromLF(region, eol));
    next = span.last + 1;
  }
  out.push(...file.lines.slice(next));
  // Two lines can merge when a replacement removed the newline between them.
  const merged: Line[] = [];
  for (const l of out) {
    const prev = merged.at(-1);
    if (prev && prev.eol === "") merged[merged.length - 1] = { text: prev.text + l.text, eol: l.eol };
    else merged.push(l);
  }
  return { bom: file.bom, lines: merged };
}
