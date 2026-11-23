// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md sections 1 to 10: the command line, the
// output and exit codes, safe paths, format detection, the three matching tiers of section 5, unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write of section 10. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful move edits, as [old path, new path], in the order they ran. */
  readonly moves: Array<readonly [string, string]> = [];
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

/** A file as lines: its own line break, the lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** Section 5: how a line is compared at each tier. */
function tierNorm(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiersTried(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every start position where O occurs in fileLines at one tier; occurrences may overlap. */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const nf = fileLines.map((l) => tierNorm(tier, l));
  const no = o.map((l) => tierNorm(tier, l));
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (nf[i + k] !== no[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function findTier(fileLines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  for (const tier of tiersTried(strict)) {
    const positions = occurrencesAt(fileLines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** One body item of a unified hunk or a V4A chunk: a context, old or new line, or a `\` marker. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

/**
 * The lines a replacement writes, walking the body items: a context line is the file's own matched line, an old
 * line is dropped, a new line is the patch's, re-indented at tier 2 as section 5 says.
 */
function buildSegment(items: BodyItem[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!) : '';
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else if (it.kind === 'new') {
      let s = it.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

/** Whether a `\` marker immediately follows the body's last context or new line. */
function markAfterLastWrite(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'new') return items[i + 1]?.kind === 'mark';
  }
  return false;
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

/** A parsed unified hunk: its header's A, its body items, and the old line texts. */
interface Hunk {
  a: number;
  items: BodyItem[];
  old: string[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: after the four characters, up to a tab, spaces removed, a/ b/ prefix removed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Apply one section's hunks in order to a file's text (SPEC.md section 6), failing the section on a bad hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(text);
  const lines = [...model.lines];
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    if (h.old.length > 0) {
      const found = findTier(lines, h.old, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const cand of found.positions) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const segment = buildSegment(h.items, lines, pos, h.old, found.tier);
      const reachesEnd = pos + h.old.length === lines.length;
      lines.splice(pos, h.old.length, ...segment);
      if (reachesEnd) final = !markAfterLastWrite(h.items);
      d += segment.length - h.old.length;
    } else {
      const pos = Math.min(h.a + d, lines.length);
      const segment = buildSegment(h.items, lines, pos, h.old, 0);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...segment);
      if (atEnd) final = !markAfterLastWrite(h.items);
      d += segment.length;
    }
  }
  return joinFile(lines, model.br, final);
}

/** The Edit one parsed unified section makes, with its paths resolved as section 6 says. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  const creation = sec.newFile || oldPath === '/dev/null';
  const deletion = sec.delFile || newPath === '/dev/null';
  return (tree) => {
    if (creation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (let i = 0; i < h.items.length; i += 1) {
          const it = h.items[i]!;
          if (it.kind === 'new') {
            content.push(it.text);
            noBreak = h.items[i + 1]?.kind === 'mark';
          }
        }
      }
      tree.now.set(p, joinFile(content, '\n', !noBreak));
      return;
    }
    if (deletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== newPath) {
      const from = oldPath!;
      const to = newPath!;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyHunks(text, sec.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, out);
      tree.moves.push([from, to]);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

/** Read a unified diff (SPEC.md section 6) into its section edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = { diffOld: null, diffNew: null, pairOld: null, pairNew: null, hasPair: false, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') items.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1) });
        else if (l[0] === '+') items.push({ kind: 'new', text: l.slice(1) });
        else if (l[0] === '\\') items.push({ kind: 'mark', text: '' });
        else break;
        j += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({
        a: Number(m[1]),
        items,
        old: items.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text),
      });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into their edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let from = 0;
  for (;;) {
    let s = -1;
    for (let k = from; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let e = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        e = k;
        break;
      }
    }
    let r = -1;
    if (e >= 0) {
      for (let k = e + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          r = k;
          break;
        }
      }
    }
    if (e < 0 || r < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, e), newLines: lines.slice(e + 1, r) });
    prevPath = path;
    prevReplace = r;
    from = r + 1;
  }
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.oldLines.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, joinFile(b.newLines, '\n', true));
          return;
        }
        const text = tree.get(b.path);
        if (text === null) throw new Fail('missing', b.path);
        const model = splitFile(text);
        const found = findTier(model.lines, b.oldLines, strict, 0);
        if (found === null) throw new Fail('no-match', b.path);
        if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
        const pos = found.positions[0]!;
        const items: BodyItem[] = b.newLines.map((t) => ({ kind: 'new' as const, text: t }));
        const segment = buildSegment(items, model.lines, pos, b.oldLines, found.tier);
        const lines = [...model.lines];
        lines.splice(pos, b.oldLines.length, ...segment);
        tree.now.set(b.path, joinFile(lines, model.br, model.final));
      },
  );
}

/** One V4A chunk: an optional anchor line, its body items, and whether `*** End of File` closed it. */
interface Chunk {
  anchor: string | null;
  items: BodyItem[];
  old: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

/** Read a V4A patch (SPEC.md section 8) into its section edits. */
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
  const sections: VSection[] = [];
  const starts: Array<readonly [string, VSection['kind']]> = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const start = starts.find(([pre]) => line.startsWith(pre));
    if (start === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const kind = start[1];
    const path = line.slice(start[0].length).trim();
    const secLine = i + 1;
    i += 1;
    const body: Array<{ text: string; line: number }> = [];
    while (i < last && !starts.some(([pre]) => lines[i]!.startsWith(pre))) {
      body.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) addLines.push(b.text.slice(1));
        else if (b.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${b.line}`);
      }
      sections.push({ kind, path, line: secLine, addLines, moveTo: null, chunks: [] });
    } else if (kind === 'del') {
      for (const b of body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.line}`);
      }
      sections.push({ kind, path, line: secLine, addLines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      const firstSolid = rest.findIndex((b) => !blank(b.text));
      if (firstSolid >= 0 && rest[firstSolid]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[firstSolid]!.text.slice(13).trim();
        rest = rest.slice(firstSolid + 1);
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (const b of rest) {
        const l = b.text;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), items: [], old: [], eof: false };
          chunks.push(cur);
        } else if (l.startsWith('***') && l.trimEnd() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, items: [], old: [], eof: false };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.line}`);
            cur = { anchor: null, items: [], old: [], eof: false };
            chunks.push(cur);
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.items.push({ kind: 'old', text: l.slice(1) });
          else cur.items.push({ kind: 'new', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.line}`);
        }
      }
      for (const c of chunks) c.old = c.items.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind, path, line: secLine, addLines: [], moveTo, chunks });
    }
  }
  return sections.map(
    (sec): Edit =>
      (tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (sec.kind === 'add') {
          if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
          tree.now.set(sec.path, joinFile(sec.addLines, '\n', true));
          return;
        }
        if (sec.kind === 'del') {
          if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
          tree.now.set(sec.path, null);
          return;
        }
        if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
        const text = tree.get(sec.path);
        if (text === null) throw new Fail('missing', sec.path);
        if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
        const model = splitFile(text);
        const fileLines = [...model.lines];
        let cursor = 0;
        for (const chunk of sec.chunks) {
          if (chunk.anchor !== null) {
            let at = -1;
            for (const tier of tiersTried(strict)) {
              for (let k = cursor; k < fileLines.length; k += 1) {
                if (tierNorm(tier, fileLines[k]!) === tierNorm(tier, chunk.anchor)) {
                  at = k;
                  break;
                }
              }
              if (at >= 0) break;
            }
            if (at < 0) throw new Fail('no-match', sec.path);
            cursor = at + 1;
          }
          if (chunk.old.length > 0) {
            let hit: { tier: number; pos: number } | null = null;
            for (const tier of tiersTried(strict)) {
              const positions = occurrencesAt(fileLines, chunk.old, tier, cursor).filter((p) => !chunk.eof || p + chunk.old.length === fileLines.length);
              if (positions.length > 0) {
                hit = { tier, pos: positions[0]! };
                break;
              }
            }
            if (hit === null) throw new Fail('no-match', sec.path);
            const segment = buildSegment(chunk.items, fileLines, hit.pos, chunk.old, hit.tier);
            fileLines.splice(hit.pos, chunk.old.length, ...segment);
            cursor = hit.pos + segment.length;
          } else {
            const pos = chunk.eof ? fileLines.length : cursor;
            const segment = buildSegment(chunk.items, fileLines, pos, chunk.old, 0);
            fileLines.splice(pos, 0, ...segment);
            cursor = pos + segment.length;
          }
        }
        const out = joinFile(fileLines, model.br, model.final);
        if (sec.moveTo !== null) {
          tree.now.set(sec.path, null);
          tree.now.set(sec.moveTo, out);
          tree.moves.push([sec.path, sec.moveTo]);
        } else {
          tree.now.set(sec.path, out);
        }
      },
  );
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
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
  const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (consumed.has(from) || consumed.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      consumed.add(from);
      consumed.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort(bytewise)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || consumed.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => bytewise(x.key, y.key));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
