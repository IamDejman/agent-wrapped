import fs from 'node:fs';
import path from 'node:path';
import { SOURCES, unreadTools } from './sources.js';
import { ls, safeParse } from './util.js';

const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const count = (n, word) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Reads one tool straight from disk (no archive) and says what came out. */
async function check(source) {
  let files = 0;
  let failed = 0;
  let events = 0;
  let first = Infinity;
  let last = 0;
  const emit = (ev) => {
    events++;
    if (ev.ts < first) first = ev.ts;
    if (ev.ts > last) last = ev.ts;
  };
  try {
    if (source.list) {
      const entries = source.list();
      files = entries.length;
      for (const e of entries) {
        try {
          await source.read(e, emit);
        } catch {
          failed++;
        }
      }
    } else if (source.stamp()) {
      files = 1;
      await source.read(emit);
    }
  } catch (err) {
    return `could not be read: ${err.message}`;
  }
  if (!files) return 'not found';
  const parts = [count(files, 'file'), count(events, 'event')];
  const profiles = source.homes?.().length ?? 1;
  if (profiles > 1) parts.push(count(profiles, 'profile'));
  if (events) parts.push(`${day(first)} to ${day(last)}`);
  if (failed) parts.push(`${failed} unreadable`);
  if (source.untested) parts.push('reader not checked against real history yet');
  return parts.join(', ');
}

// Folder names can be project names, so only short plain words are shown.
const mask = (segment) => (/^[a-z]{2,12}$/.test(segment) ? segment : '*');
const maskFile = (name) => name.replace(/[0-9a-f]{8}[0-9a-f-]{4,}|\d{4,}/gi, '*');
const SECRET = /auth|credential|token|secret|key|cookie|\.env/i;
const LABELS = ['type', 'role', 'kind', 'event', 'method'];

/** Field names two levels deep, never values: { a: { b: 1 }, c: [{ d: 2 }] } -> a, a.b, c[], c[].d */
function fields(value, prefix, depth, out) {
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object' || depth > 2) return;
  for (const [k, v] of Object.entries(value)) {
    const name = `${prefix}${/^[\w$-]{1,40}$/.test(k) ? k : '*'}${Array.isArray(v) ? '[]' : ''}`;
    out.add(name);
    fields(v, `${name}.`, depth + 1, out);
  }
}

/** What one file is made of: its record types and their field names. */
function describe(file) {
  const ext = path.extname(file);
  if (ext !== '.json' && ext !== '.jsonl') return [];
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 << 20));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const records = ext === '.json' ? [safeParse(text)] : text.split('\n', 2000).map(safeParse);
  const groups = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const label = LABELS.map((k) => [k, r[k]]).find(([, v]) => typeof v === 'string' && /^[\w.:/-]{1,48}$/.test(v));
    const key = label ? `${label[0]}=${label[1]}` : 'record';
    if (!groups.has(key)) groups.set(key, new Set());
    fields(r, '', 1, groups.get(key));
  }
  return [...groups].map(([key, set]) => `${key}: ${[...set].sort().join(', ')}`);
}

/** The shape of a tool's folder: file patterns with counts, and the field names inside one of each. */
function layout(root) {
  const patterns = new Map();
  const walk = (dir, masked, depth) => {
    if (depth > 6 || patterns.size > 60) return;
    for (const name of ls(dir)) {
      if (SECRET.test(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, [...masked, mask(name)], depth + 1);
      else {
        const key = [...masked, maskFile(name)].join('/');
        const p = patterns.get(key) ?? { n: 0, sample: full };
        p.n++;
        patterns.set(key, p);
      }
    }
  };
  walk(root, [], 0);
  return [...patterns].flatMap(([key, p]) => [`  ${key}  (${count(p.n, 'file')})`, ...describe(p.sample).map((line) => `    ${line}`)]);
}

/**
 * What the wrap can see on this machine. For tools it has no reader for, it
 * prints the layout of their history (file patterns and field names, never
 * contents), which is what's needed to add a reader.
 */
export async function doctor(print = console.log) {
  const width = Math.max(...SOURCES.map((s) => s.name.length)) + 2;
  for (const source of SOURCES) {
    if (source.read) print(`${source.name.padEnd(width)}${await check(source)}`);
  }
  for (const [name, dir] of unreadTools()) {
    print(`\n${name}: found, not read yet. Layout (names only, no contents):`);
    for (const line of layout(dir)) print(line);
  }
}
