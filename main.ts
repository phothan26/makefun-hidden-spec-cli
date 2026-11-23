// mend — one patch tool for every AI edit format.
//
// Applies an AI-written edit to a tree of text files. The edit comes in one
// of four formats: a unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, or text-editor tool calls as JSON. The full contract is SPEC.md:
// the command line and exit codes, safe paths, format detection, the
// three-tier line matching, and the per-format readers. Every edit either
// applies whole or fails whole, and when any edit fails no file is written.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial (MAKEFUN_ENV_URL set) this hands over to runner.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An error that ends the run with exit 2 and exactly one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its
 *  /-separated segments is empty, . or .. . */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

interface FileState {
  lines: string[];
  brk: '\n' | '\r\n';
  eol: boolean;
}

/** Section 3: the break is CRLF when the first line feed follows a carriage return, else LF; the lines are
 *  the text split at that break, the last empty piece not a line; an empty file has no lines and no break. */
function parseText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  let brk: '\n' | '\r\n' = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  const eol = text.endsWith(brk);
  const lines = text.split(brk);
  if (eol) lines.pop();
  return { lines, brk, eol };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.eol ? f.brk : '');
}

/** The tree as the edits leave it. `orig` is what the files held on disk (null: absent), read lazily;
 *  `now` is the current state (null: deleted). FileState values are never mutated in place, so a shallow
 *  copy of `now` is a full snapshot for rolling one edit back. */
class Tree {
  private readonly orig = new Map<string, FileState | null>();
  private nowMap = new Map<string, FileState | null>();
  /** Moves that succeeded, for the R lines of the exit-0 output. */
  readonly renames: { old: string; nw: string }[] = [];

  original(p: string): FileState | null {
    if (!this.orig.has(p)) {
      let v: FileState | null = null;
      try {
        if (statSync(p).isFile()) v = parseText(readFileSync(p, 'utf8'));
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as FileState | null;
  }

  get(p: string): FileState | null {
    if (this.nowMap.has(p)) return this.nowMap.get(p) as FileState | null;
    return this.original(p);
  }

  set(p: string, f: FileState): void {
    this.nowMap.set(p, f);
  }

  delete(p: string): void {
    this.nowMap.set(p, null);
  }

  snapshot(): Map<string, FileState | null> {
    return new Map(this.nowMap);
  }

  restore(s: Map<string, FileState | null>): void {
    this.nowMap = s;
  }

  get now(): Map<string, FileState | null> {
    return this.nowMap;
  }
}

/* ------------------------------------------------------------------ */
/* Matching (section 5)                                                */
/* ------------------------------------------------------------------ */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  return normLine(a, tier) === normLine(b, tier);
}

/** Positions i (at or after `from`) where O's lines match the file's lines i, i+1, ...; occurrences may overlap. */
function findOccurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once, with its positions. */
function findFirstTier(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'backslash';
  text: string;
}

/** Build N from a hunk/chunk body: context lines are written as the file's own matched lines, never the
 *  patch's; at tier 2 every other line is re-indented (F from the file's first matched line, P from O's
 *  first line). `occStart` is where O matched in the file. */
function buildReplacement(body: BodyItem[], fileLines: string[], occStart: number, tier: number): string[] {
  const oldLines = body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
  const f = oldLines.length > 0 ? leadingWs(fileLines[occStart]) : '';
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'backslash') continue;
    if (b.kind === 'del') {
      oIdx++;
      continue;
    }
    if (b.kind === 'ctx') {
      out.push(fileLines[occStart + oIdx]);
      oIdx++;
      continue;
    }
    let t = b.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The new lines of a SEARCH/REPLACE or JSON block (no context lines): at tier 2 every line is re-indented. */
function reindentLines(newLines: string[], fileFirst: string, oldFirst: string, tier: number): string[] {
  if (tier !== 2) return [...newLines];
  const f = leadingWs(fileFirst);
  const p = leadingWs(oldFirst);
  return newLines.map((t) => {
    if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** Replace lines [pos, pos + oldLen) with newLines. `eol` is the result's final break (the caller decides it:
 *  section 6 for unified hunks, the file's own break otherwise). A file left with no lines has no break. */
function replaceRange(f: FileState, pos: number, oldLen: number, newLines: string[], eol: boolean): FileState {
  const lines = [...f.lines.slice(0, pos), ...newLines, ...f.lines.slice(pos + oldLen)];
  return { lines, brk: f.brk, eol: lines.length === 0 ? false : eol };
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

interface Failure {
  code: string;
  path: string;
}

interface EditOpts {
  strict: boolean;
}

interface Edit {
  /** Paths the edit names, in order; every one is checked for safety before anything else about the edit. */
  paths: string[];
  /** Apply to the tree. Returns null on success, or the failure to report. A failure changes nothing. */
  apply(tree: Tree, opts: EditOpts): Failure | null;
}

function unsafeCheck(paths: string[]): Failure | null {
  for (const p of paths) {
    if (!safe(p)) return { code: 'unsafe', path: p };
  }
  return null;
}

/** The eol rule for a non-unified replacement (section 3): the final break stays as it was, except that
 *  deleting the file's last lines leaves the new last line — which a line followed — ending with a break. */
function preservedEol(f: FileState, pos: number, oldLen: number, newLen: number): boolean {
  if (pos + oldLen >= f.lines.length && newLen === 0) return pos > 0;
  return f.eol;
}

/* ------------------------------------------------------------------ */
/* Command line (section 1)                                            */
/* ------------------------------------------------------------------ */

interface CliOpts {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliOpts {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('--format=')) {
      if (seenFormat) throw new Exit2('error: usage');
      seenFormat = true;
      const v = a.slice('--format='.length);
      if (!FORMATS.includes(v)) throw new Exit2('error: usage');
      format = v;
      continue;
    }
    if (!endOpts && a === '--check') {
      if (seenCheck) throw new Exit2('error: usage');
      seenCheck = true;
      check = true;
      continue;
    }
    if (!endOpts && a === '--strict') {
      if (seenStrict) throw new Exit2('error: usage');
      seenStrict = true;
      strict = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') throw new Exit2('error: usage');
    positionals.push(a);
  }
  if (positionals.length > 1) throw new Exit2('error: usage');
  return { format, check, strict, patch: positionals.length === 1 ? positionals[0] : null };
}

function readPatch(patch: string | null): string {
  if (patch === null || patch === '-') return readFileSync(0, 'utf8');
  try {
    return readFileSync(patch, 'utf8');
  } catch {
    throw new Exit2('error: no-patch');
  }
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): 'unified' | 'search-replace' | 'v4a' | 'json' {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) throw new Exit2('error: format');
  const first = lines[firstIdx];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const firstCh = first.trimStart()[0];
  if (firstCh === '[' || firstCh === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  throw new Exit2('error: format');
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  a: number;
  body: BodyItem[];
  noEol: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  pairSet: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UnifiedHunk[];
  startLine: number;
}

/** The path of a --- / +++ header line: text after the four characters, up to the first tab, surrounding
 *  spaces removed; /dev/null means no file; a leading a/ or b/ is removed from either. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function isUnifiedBodyLine(line: string): boolean {
  return (
    line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')
  );
}

function unifiedBodyItem(line: string): BodyItem {
  if (line === '') return { kind: 'ctx', text: '' };
  if (line[0] === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (line[0] === '-') return { kind: 'del', text: line.slice(1) };
  if (line[0] === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'backslash', text: line.slice(1) };
}

/** Empty lines at the end of a body are not part of it. A trailing context line whose text is empty is
 *  dropped, unless a \ line follows it (the \ refers to that line). */
function dropTrailingEmptyBody(body: BodyItem[]): void {
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'backslash') break;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
}

/** A \ line follows the hunk's last context or + line. */
function hunkNoEol(body: BodyItem[]): boolean {
  let lastIdx = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'add') lastIdx = i;
  }
  if (lastIdx < 0) return false;
  const next = body[lastIdx + 1];
  return next !== undefined && next.kind === 'backslash';
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let curHunk: UnifiedHunk | null = null;
  let inHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const next = lines[i + 1];

    // A --- line followed by a +++ line: a section start, or the current header's path pair.
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      curHunk = null;
      if (cur !== null && inHeader) {
        if (!cur.pairSet) {
          cur.oldPath = headerPath(line);
          cur.newPath = headerPath(next);
          cur.pairSet = true;
        }
      } else {
        cur = {
          oldPath: headerPath(line),
          newPath: headerPath(next),
          pairSet: true,
          isNew: false,
          isDeleted: false,
          hunks: [],
          startLine: lineNo,
        };
        inHeader = true;
        sections.push(cur);
      }
      i++;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      curHunk = null;
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      cur = {
        oldPath: m[1],
        newPath: m[2],
        pairSet: false,
        isNew: false,
        isDeleted: false,
        hunks: [],
        startLine: lineNo,
      };
      inHeader = true;
      sections.push(cur);
      continue;
    }

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      curHunk = { a: Number(m[1]), body: [], noEol: false };
      cur.hunks.push(curHunk);
      inHeader = false;
      continue;
    }

    if (curHunk !== null && isUnifiedBodyLine(line)) {
      curHunk.body.push(unifiedBodyItem(line));
      continue;
    }
    curHunk = null;

    // A --- line not followed by +++ : in a header it is a parse error at the line after it; elsewhere ignored.
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${lineNo + 1}`);
      continue;
    }

    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ') && !cur.pairSet) {
        cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ') && !cur.pairSet) {
        cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDeleted = true;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
  }

  for (const s of sections) {
    for (const h of s.hunks) {
      dropTrailingEmptyBody(h.body);
      h.noEol = hunkNoEol(h.body);
    }
  }
  return sections.map(unifiedSectionEdit);
}

function unifiedSectionEdit(s: UnifiedSection): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreate = oldP === null || s.isNew;
  const isDelete = newP === null || s.isDeleted;
  let kind: 'create' | 'delete' | 'move' | 'change';
  let paths: string[];
  if (isCreate && !isDelete && newP !== null) {
    kind = 'create';
    paths = [newP];
  } else if (isDelete && !isCreate && oldP !== null) {
    kind = 'delete';
    paths = [oldP];
  } else if (oldP !== null && newP !== null && oldP !== newP) {
    kind = 'move';
    paths = [oldP, newP];
  } else if (oldP !== null) {
    kind = 'change';
    paths = [oldP];
  } else if (newP !== null) {
    kind = 'change';
    paths = [newP];
  } else {
    kind = 'change';
    paths = [];
  }
  return {
    paths,
    apply(tree: Tree, opts: EditOpts): Failure | null {
      const bad = unsafeCheck(paths);
      if (bad !== null) return bad;
      if (kind === 'create') {
        const p = newP as string;
        if (tree.get(p) !== null) return { code: 'exists', path: p };
        const plus: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.kind === 'add') plus.push(b.text);
          }
        }
        // A created file ends with a line break unless a \ line follows its last + line.
        let noEol = false;
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const h = s.hunks[hi];
          for (let j = h.body.length - 1; j >= 0; j--) {
            if (h.body[j].kind === 'add') {
              noEol = h.body[j + 1] !== undefined && h.body[j + 1].kind === 'backslash';
              break outer;
            }
          }
        }
        tree.set(p, { lines: plus, brk: '\n', eol: !noEol });
        return null;
      }
      if (kind === 'delete') {
        const p = oldP as string;
        if (tree.get(p) === null) return { code: 'missing', path: p };
        tree.delete(p);
        return null;
      }
      const p = oldP as string;
      const f = tree.get(p);
      if (f === null) return { code: 'missing', path: p };
      if (kind === 'move') {
        const np = newP as string;
        if (tree.get(np) !== null) return { code: 'exists', path: np };
      }
      const applied = applyUnifiedHunks(f, s.hunks, opts.strict);
      if (applied === null) return { code: 'no-match', path: p };
      if (kind === 'move') {
        tree.set(newP as string, applied);
        tree.delete(p);
        tree.renames.push({ old: p, nw: newP as string });
      } else {
        tree.set(p, applied);
      }
      return null;
    },
  };
}

/** Apply a section's hunks in order to a file's lines. Returns null when a hunk's O is not found. */
function applyUnifiedHunks(f: FileState, hunks: UnifiedHunk[], strict: boolean): FileState | null {
  let lines = f.lines;
  let eol = f.eol;
  let d = 0;
  for (const h of hunks) {
    const oLines = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
    if (oLines.length === 0) {
      const nLines = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...nLines, ...lines.slice(pos)];
      if (atEnd) eol = !h.noEol;
      d += nLines.length;
      continue;
    }
    const found = findFirstTier(lines, oLines, 0, strict);
    if (found === null) return null;
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const nLines = buildReplacement(h.body, lines, best, found.tier);
    const runsToEof = best + oLines.length >= lines.length;
    lines = [...lines.slice(0, best), ...nLines, ...lines.slice(best + oLines.length)];
    if (runsToEof) eol = !h.noEol;
    d += nLines.length - oLines.length;
  }
  return { lines, brk: f.brk, eol: lines.length === 0 ? false : eol };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= i; j--) {
      const t = lines[j];
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (edits.length === 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = edits[edits.length - 1].paths[0];
    }
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j].replace(/[ \t]+$/, '') === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let endIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j].replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    i = endIdx + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    paths: [path],
    apply(tree: Tree, opts: EditOpts): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      const f = tree.get(path);
      if (oldLines.length === 0) {
        if (f !== null) return { code: 'exists', path };
        tree.set(path, { lines: [...newLines], brk: '\n', eol: true });
        return null;
      }
      if (f === null) return { code: 'missing', path };
      const found = findFirstTier(f.lines, oldLines, 0, opts.strict);
      if (found === null) return { code: 'no-match', path };
      if (found.occ.length > 1) return { code: 'ambiguous', path };
      const pos = found.occ[0];
      const nLines = reindentLines(newLines, f.lines[pos], oldLines[0], found.tier);
      tree.set(path, replaceRange(f, pos, oldLines.length, nLines, preservedEol(f, pos, oldLines.length, nLines.length)));
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string;
  body: BodyItem[];
  eof: boolean;
}

function isV4aBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function v4aBodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (l[0] === '-') return { kind: 'del', text: l.slice(1) };
  return { kind: 'add', text: l.slice(1) };
}

function parseV4a(lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      lastIdx = i;
      break;
    }
  }
  if (lines[lastIdx].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1];
    const path = m[2].trim();
    const secStart = i;
    i++;
    const secLines: { text: string; lineNo: number }[] = [];
    while (i < lastIdx) {
      const l = lines[i];
      if (/^\*\*\* (Add File|Delete File|Update File): /.test(l)) break;
      secLines.push({ text: l, lineNo: i + 1 });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1].text)) secLines.pop();

    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else if (sl.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${sl.lineNo}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'Delete File') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0].lineNo}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0].text.startsWith('*** Move to: ')) {
        moveTo = secLines[0].text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; idx < secLines.length; idx++) {
        const sl = secLines[idx];
        if (sl.text.startsWith('@@')) {
          cur = { anchor: sl.text.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (sl.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${sl.lineNo}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (isV4aBodyLine(sl.text)) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${sl.lineNo}`);
            cur = { anchor: '', body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(v4aBodyItem(sl.text));
          continue;
        }
        throw new Exit2(`error: parse ${sl.lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secStart + 1}`);
      for (const c of chunks) dropTrailingEmptyBody(c.body);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return {
    paths: [path],
    apply(tree: Tree): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      if (tree.get(path) !== null) return { code: 'exists', path };
      tree.set(path, { lines: [...fileLines], brk: '\n', eol: true });
      return null;
    },
  };
}

function v4aDeleteEdit(path: string): Edit {
  return {
    paths: [path],
    apply(tree: Tree): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      if (tree.get(path) === null) return { code: 'missing', path };
      tree.delete(path);
      return null;
    },
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return {
    paths: moveTo !== null ? [path, moveTo] : [path],
    apply(tree: Tree, opts: EditOpts): Failure | null {
      const bad = unsafeCheck(moveTo !== null ? [path, moveTo] : [path]);
      if (bad !== null) return bad;
      const f = tree.get(path);
      if (f === null) return { code: 'missing', path };
      if (moveTo !== null && tree.get(moveTo) !== null) return { code: 'exists', path: moveTo };
      let lines = f.lines;
      let eol = f.eol;
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== '') {
          let foundAt = -1;
          const tiers = opts.strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let k = cursor; k < lines.length; k++) {
              if (lineEq(lines[k], c.anchor, t)) {
                foundAt = k;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) return { code: 'no-match', path };
          cursor = foundAt + 1;
        }
        const oLines = c.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
        if (oLines.length === 0) {
          const nLines = c.body.filter((b) => b.kind === 'add').map((b) => b.text);
          const pos = c.eof ? lines.length : cursor;
          lines = [...lines.slice(0, pos), ...nLines, ...lines.slice(pos)];
          cursor = pos + nLines.length;
          continue;
        }
        let found: { tier: number; pos: number } | null = null;
        const tiers = opts.strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = findOccurrences(lines, oLines, t, cursor);
          const good = c.eof ? occ.filter((p) => p + oLines.length === lines.length) : occ;
          if (good.length > 0) {
            found = { tier: t, pos: good[0] };
            break;
          }
        }
        if (found === null) return { code: 'no-match', path };
        const nLines = buildReplacement(c.body, lines, found.pos, found.tier);
        const newEol = preservedEol(
          { lines, brk: f.brk, eol },
          found.pos,
          oLines.length,
          nLines.length,
        );
        lines = [...lines.slice(0, found.pos), ...nLines, ...lines.slice(found.pos + oLines.length)];
        eol = lines.length === 0 ? false : newEol;
        cursor = found.pos + nLines.length;
      }
      const out: FileState = { lines, brk: f.brk, eol: lines.length === 0 ? false : eol };
      if (moveTo !== null) {
        tree.set(moveTo, out);
        tree.delete(path);
        tree.renames.push({ old: path, nw: moveTo });
      } else {
        tree.set(path, out);
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

function parseJson(lines: string[], patchText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx < 0) return [];
  const firstCh = lines[firstIdx].trimStart()[0];
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new Exit2(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(arr)) throw new Exit2(`error: parse ${firstIdx + 1}`);
    return arr.map((el) => jsonEditObject(el, firstIdx + 1));
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    edits.push(jsonEditObject(obj, i + 1));
  }
  return edits;
}

function jsonEditObject(el: unknown, lineNo: number): Edit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new Exit2(`error: parse ${lineNo}`);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new Exit2(`error: parse ${lineNo}`);
  if (typeof o.command !== 'string') throw new Exit2(`error: parse ${lineNo}`);
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new Exit2(`error: parse ${lineNo}`);
    return jsonCreateEdit(path, o.file_text as string);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') throw new Exit2(`error: parse ${lineNo}`);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new Exit2(`error: parse ${lineNo}`);
    return jsonStrReplaceEdit(path, o.old_str as string, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (typeof o.new_str !== 'string') throw new Exit2(`error: parse ${lineNo}`);
    return jsonInsertEdit(path, o.insert_line as number, o.new_str as string);
  }
  throw new Exit2(`error: parse ${lineNo}`);
}

function jsonCreateEdit(path: string, fileText: string): Edit {
  return {
    paths: [path],
    apply(tree: Tree): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      if (tree.get(path) !== null) return { code: 'exists', path };
      tree.set(path, parseText(fileText));
      return null;
    },
  };
}

function jsonStrReplaceEdit(path: string, oldStr: string, newStr: string): Edit {
  return {
    paths: [path],
    apply(tree: Tree): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      const f = tree.get(path);
      if (f === null) return { code: 'missing', path };
      let text = renderFile(f);
      let o = oldStr;
      let n = newStr;
      if (f.brk === '\r\n') {
        text = text.replace(/\r\n/g, '\n');
        o = o.replace(/\r\n/g, '\n');
        n = n.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let first = -1;
      let from = 0;
      for (;;) {
        const p = text.indexOf(o, from);
        if (p < 0) break;
        count++;
        if (first < 0) first = p;
        from = p + 1;
      }
      if (count === 0) return { code: 'no-match', path };
      if (count > 1) return { code: 'ambiguous', path };
      const result = text.slice(0, first) + n + text.slice(first + o.length);
      const outText = f.brk === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
      tree.set(path, parseText(outText));
      return null;
    },
  };
}

function jsonInsertEdit(path: string, insertLine: number, newStr: string): Edit {
  return {
    paths: [path],
    apply(tree: Tree): Failure | null {
      const bad = unsafeCheck([path]);
      if (bad !== null) return bad;
      const f = tree.get(path);
      if (f === null) return { code: 'missing', path };
      if (insertLine < 0 || insertLine > f.lines.length) return { code: 'no-match', path };
      const newLines = splitPatchLines(newStr);
      const lines = [...f.lines.slice(0, insertLine), ...newLines, ...f.lines.slice(insertLine)];
      tree.set(path, { lines, brk: f.brk, eol: f.eol });
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Output and writing (sections 2 and 10)                              */
/* ------------------------------------------------------------------ */

interface Change {
  kind: 'A' | 'D' | 'M' | 'R';
  path: string;
  old?: string;
  nw?: string;
}

function changeKey(c: Change): string {
  return c.kind === 'R' ? (c.nw as string) : c.path;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function computeChanges(tree: Tree): Change[] {
  const changes: Change[] = [];
  const deleted = new Set<string>();
  const created = new Set<string>();
  const modified = new Set<string>();
  for (const [p, now] of tree.now) {
    const orig = tree.original(p);
    if (now === null && orig !== null) deleted.add(p);
    else if (now !== null && orig === null) created.add(p);
    else if (now !== null && orig !== null && renderFile(now) !== renderFile(orig)) modified.add(p);
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const r of tree.renames) {
    if (deleted.has(r.old) && created.has(r.nw)) {
      changes.push({ kind: 'R', path: r.nw, old: r.old, nw: r.nw });
      usedOld.add(r.old);
      usedNew.add(r.nw);
    }
  }
  for (const p of deleted) {
    if (!usedOld.has(p)) changes.push({ kind: 'D', path: p });
  }
  for (const p of created) {
    if (!usedNew.has(p)) changes.push({ kind: 'A', path: p });
  }
  for (const p of modified) changes.push({ kind: 'M', path: p });
  changes.sort((a, b) => byteCompare(changeKey(a), changeKey(b)));
  return changes;
}

/** Only files and directories the run itself creates are given modes (0644 / 0755); existing files and
 *  directories, and the working directory itself, are never re-chmodded. */
function ensureDir(dir: string): void {
  if (dir === '' || dir === '.') return;
  const parts = dir.split('/');
  let cur = '';
  for (const part of parts) {
    cur = cur === '' ? part : cur + '/' + part;
    if (!existsSync(cur)) {
      mkdirSync(cur);
      chmodSync(cur, 0o755);
    }
  }
}

function writeChanges(tree: Tree, changes: Change[]): void {
  for (const c of changes) {
    if (c.kind === 'D') {
      try {
        unlinkSync(c.path);
      } catch {
        // already gone
      }
    } else if (c.kind === 'R') {
      const f = tree.now.get(c.nw as string) as FileState;
      ensureDir(dirname(c.nw as string));
      const existed = existsSync(c.nw as string);
      writeFileSync(c.nw as string, renderFile(f), 'utf8');
      if (!existed) chmodSync(c.nw as string, 0o644);
      try {
        unlinkSync(c.old as string);
      } catch {
        // already gone
      }
    } else {
      const f = tree.now.get(c.path) as FileState;
      ensureDir(dirname(c.path));
      const existed = existsSync(c.path);
      writeFileSync(c.path, renderFile(f), 'utf8');
      if (!existed) chmodSync(c.path, 0o644);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function runCli(argv: string[]): number {
  const opts = parseArgs(argv);
  const patchText = readPatch(opts.patch);
  const lines = splitPatchLines(patchText);
  const format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  let edits: Edit[];
  if (format === 'unified') edits = parseUnified(lines);
  else if (format === 'search-replace') edits = parseSearchReplace(lines);
  else if (format === 'v4a') edits = parseV4a(lines);
  else edits = parseJson(lines, patchText);
  if (edits.length === 0) throw new Exit2('error: parse 1');

  const tree = new Tree();
  const failures: Failure[] = [];
  for (const ed of edits) {
    const snap = tree.snapshot();
    const renamesLen = tree.renames.length;
    const fail = ed.apply(tree, { strict: opts.strict });
    if (fail !== null) {
      tree.restore(snap);
      tree.renames.length = renamesLen;
      failures.push(fail);
    }
  }

  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }

  const changes = computeChanges(tree);
  if (!opts.check) writeChanges(tree, changes);
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === 'R') out.push(`R ${c.old} -> ${c.nw}`);
    else out.push(`${c.kind} ${c.path}`);
  }
  out.push(`ok: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  // A trial: hand over to the kit's runner, which runs main.ts on each check of the env.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Exit2) {
      process.stdout.write(e.line + '\n');
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}
