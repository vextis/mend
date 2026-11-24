// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 3 and 5: a file as lines, and tiered matching ----------

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, br, finalBreak };
}

function joinFile(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.finalBreak ? fl.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function matchTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

function tiersTried(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position where O matches, at the first tier that has one; null when O matches at no tier. */
function occurrences(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tiersTried(strict)) {
    const positions: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!matchTier(lines[i + k]!, O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk, block or chunk: context (' '), old ('-') or new ('+'); bs: a `\` line follows it. */
interface Item {
  kind: string;
  text: string;
  bs: boolean;
}

/** The lines a matched range is replaced by: context lines are the file's own, additions as written (re-indented at tier 2). */
function buildFromItems(lines: string[], pos: number, items: Item[], tier: number, O: string[]): string[] {
  const F = leadingWS(lines[pos] ?? '');
  const P = leadingWS(O[0] ?? '');
  const out: string[] = [];
  let m = pos;
  for (const it of items) {
    if (it.kind === ' ') {
      out.push(lines[m]!);
      m += 1;
    } else if (it.kind === '-') {
      m += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(s: string): string {
  const tab = s.indexOf('\t');
  return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = rest.slice(2, sep);
      s.gitNew = rest.slice(sep + 3);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = stripPrefix(headerPath(line.slice(4)));
      const n = stripPrefix(headerPath(lines[i + 1]!.slice(4)));
      if (cur !== null && inHeader && cur.pairOld === null) {
        cur.pairOld = o;
        cur.pairNew = n;
      } else {
        const s = newSection();
        s.pairOld = o;
        s.pairNew = n;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          j += 1;
          continue;
        }
        break;
      }
      const body = lines.slice(i + 1, j);
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const items: Item[] = [];
      for (const b of body) {
        if (b.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.bs = true;
          continue;
        }
        if (b === '') items.push({ kind: ' ', text: '', bs: false });
        else items.push({ kind: b[0]!, text: b.slice(1), bs: false });
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), items });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  // The working array keeps the empty piece after a final line break as a last, virtual line, so a hunk whose
  // context runs to that piece still matches; it is folded back into finalBreak at the end.
  const W = fl.finalBreak ? [...fl.lines, ''] : [...fl.lines];
  let virt = fl.finalBreak;
  let fbOverride: boolean | null = null;
  let d = 0;
  const realLen = (): number => W.length - (virt ? 1 : 0);
  const fold = (): void => {
    virt = virt && W.length > 0 && W[W.length - 1] === '';
  };
  for (const h of hunks) {
    const O = h.items.filter((it) => it.kind !== '+').map((it) => it.text);
    const nLen = h.items.filter((it) => it.kind !== '-').length;
    if (O.length > 0) {
      const occ = occurrences(W, O, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = occ.positions[0]!;
      for (const p of occ.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const atEnd = pos + O.length >= realLen();
      const repl = buildFromItems(W, pos, h.items, occ.tier, O);
      W.splice(pos, O.length, ...repl);
      fold();
      if (atEnd) {
        const lastCtxAdd = [...h.items].reverse().find((it) => it.kind !== '-');
        fbOverride = !(lastCtxAdd !== undefined && lastCtxAdd.bs);
      }
      d += nLen - O.length;
    } else {
      const adds = h.items.filter((it) => it.kind === '+');
      const idx = Math.min(h.a + d, realLen());
      const atEnd = idx === realLen();
      W.splice(idx, 0, ...adds.map((it) => it.text));
      fold();
      if (atEnd) {
        const lastAdd = adds[adds.length - 1];
        fbOverride = !(lastAdd !== undefined && lastAdd.bs);
      }
      d += adds.length;
    }
  }
  const lines = virt ? W.slice(0, -1) : W;
  return { lines, br: fl.br, finalBreak: fbOverride ?? virt };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
  const isCreate = sec.pairOld === '/dev/null' || sec.newFile;
  const isDelete = sec.pairNew === '/dev/null' || sec.deletedFile;
  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastPlus: Item | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            out.push(it.text);
            lastPlus = it;
          }
        }
      }
      tree.now.set(p, joinFile({ lines: out, br: '\n', finalBreak: lastPlus === null ? true : !lastPlus.bs }));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldPath!;
    const n = newPath!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (n !== o && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const fl = applyHunks(splitFile(before), sec.hunks, strict, o);
    if (n !== o) {
      tree.now.set(n, joinFile(fl));
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, joinFile(fl));
    }
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srBlockEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitFile(before);
    const W = fl.finalBreak ? [...fl.lines, ''] : [...fl.lines];
    const occ = occurrences(W, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const items: Item[] = newLines.map((t) => ({ kind: '+', text: t, bs: false }));
    const repl = buildFromItems(W, pos, items, occ.tier, oldLines);
    W.splice(pos, oldLines.length, ...repl);
    const virt = fl.finalBreak && W.length > 0 && W[W.length - 1] === '';
    tree.now.set(path, joinFile({ lines: virt ? W.slice(0, -1) : W, br: fl.br, finalBreak: virt }));
  };
}

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const startLine = i + 1;
    let j = i + 1;
    const content: { line: string; n: number }[] = [];
    while (j < last && sectionStart(lines[j]!) === null) {
      content.push({ line: lines[j]!, n: j + 1 });
      j += 1;
    }
    while (content.length > 0 && content[content.length - 1]!.line === '') content.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, content));
    else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.n}`);
      edits.push(v4aDeleteEdit(path));
    } else edits.push(v4aUpdateEdit(path, content, startLine, strict));
    i = j;
  }
  return edits;
}

function v4aAddEdit(path: string, content: { line: string; n: number }[]): Edit {
  const fileLines: string[] = [];
  for (const c of content) {
    if (c.line.startsWith('+')) fileLines.push(c.line.slice(1));
    else if (c.line === '') fileLines.push('');
    else throw new Exit2(`error: parse ${c.n}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile({ lines: fileLines, br: '\n', finalBreak: true }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyChunks(fl: FileLines, chunks: Chunk[], strict: boolean, path: string): FileLines {
  // As in applyHunks, the working array keeps the empty piece after a final line break as a virtual last line.
  const W = fl.finalBreak ? [...fl.lines, ''] : [...fl.lines];
  let virt = fl.finalBreak;
  let cursor = 0;
  const realLen = (): number => W.length - (virt ? 1 : 0);
  const fold = (): void => {
    virt = virt && W.length > 0 && W[W.length - 1] === '';
  };
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (const tier of tiersTried(strict)) {
        for (let k = cursor; k < W.length; k += 1) {
          if (matchTier(W[k]!, ch.anchor, tier)) {
            found = k;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O = ch.items.filter((it) => it.kind !== '+').map((it) => it.text);
    if (O.length > 0) {
      let hit: { tier: number; pos: number } | null = null;
      for (const tier of tiersTried(strict)) {
        for (let p = cursor; p + O.length <= W.length; p += 1) {
          if (ch.eof && p + O.length < realLen()) continue;
          let ok = true;
          for (let k = 0; k < O.length; k += 1) {
            if (!matchTier(W[p + k]!, O[k]!, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            hit = { tier, pos: p };
            break;
          }
        }
        if (hit !== null) break;
      }
      if (hit === null) throw new Fail('no-match', path);
      const repl = buildFromItems(W, hit.pos, ch.items, hit.tier, O);
      W.splice(hit.pos, O.length, ...repl);
      fold();
      cursor = hit.pos + repl.length;
    } else {
      const adds = ch.items.map((it) => it.text);
      const idx = ch.eof ? realLen() : Math.min(cursor, realLen());
      W.splice(idx, 0, ...adds);
      fold();
      cursor = idx + adds.length;
    }
  }
  return { lines: virt ? W.slice(0, -1) : W, br: fl.br, finalBreak: virt };
}

function v4aUpdateEdit(path: string, content: { line: string; n: number }[], startLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.line.startsWith('*** Move to: ')) {
    moveTo = content[0]!.line.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = idx; k < content.length; k += 1) {
    const c = content[k]!;
    const l = c.line;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.n}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.n}`);
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      cur.items.push(l === '' ? { kind: ' ', text: '', bs: false } : { kind: l[0]!, text: l.slice(1), bs: false });
    } else {
      throw new Exit2(`error: parse ${c.n}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fl = applyChunks(splitFile(before), chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, joinFile(fl));
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, joinFile(fl));
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const moveNew = new Map<string, string>();
  const moveOld = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (moveNew.has(n) || moveOld.has(o)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      moveNew.set(n, o);
      moveOld.add(o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of changed) {
    if (moveOld.has(p)) continue;
    if (moveNew.has(p)) rows.push({ key: p, line: `R ${moveNew.get(p)!} -> ${p}` });
    else {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
