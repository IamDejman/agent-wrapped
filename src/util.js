import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Stream a JSONL file and call onLine with each line as a Buffer.
 * Lines stay as Buffers so callers can cheaply skip the ones they don't need
 * before paying for string decoding and JSON.parse. A .zst file (Codex
 * compresses archived chats) is decompressed on the way through.
 */
export async function eachLine(file, onLine) {
  let stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (file.endsWith('.zst')) {
    if (!zlib.createZstdDecompress) throw new Error('compressed chats need Node 22.15 or newer');
    stream = stream.pipe(zlib.createZstdDecompress());
  }
  let parts = [];
  for await (const chunk of stream) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      const piece = chunk.subarray(start, nl);
      const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
      parts = [];
      if (line.length) onLine(line);
      start = nl + 1;
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  }
  if (parts.length) onLine(Buffer.concat(parts));
}

/** Names in a directory, or nothing when it can't be read. */
export function ls(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Size and modified time of a file, used to tell whether it changed since the
 * last run. SQLite keeps recent writes in a -wal file beside the database, so
 * that counts too. Null when the file is missing.
 */
export function fileStamp(file) {
  let stamp = null;
  for (const f of [file, `${file}-wal`]) {
    try {
      const s = fs.statSync(f);
      stamp = { size: (stamp?.size ?? 0) + s.size, mtimeMs: Math.max(stamp?.mtimeMs ?? 0, s.mtimeMs) };
    } catch {
      if (f === file) return null;
    }
  }
  return stamp;
}

/** Recursively list .jsonl files (and compressed .jsonl.zst ones) under dir, with their depth below it. */
export function findJsonl(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, depth + 1, out);
    else if (/\.jsonl(\.zst)?$/.test(e.name)) {
      const s = fs.statSync(p);
      out.push({ file: p, depth, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

/**
 * Every folder one tool keeps history in. A second account or profile is the
 * same tool pointed at a sibling folder (CLAUDE_CONFIG_DIR=~/.claude-work), so
 * folders named like the default count too when they hold one of the markers.
 */
export function homes(base, { env, markers, parent = os.homedir(), extra = [] }) {
  const siblings = ls(parent)
    .filter((n) => n === base || (n.startsWith(base) && /^[-_.]/.test(n.slice(base.length))))
    .sort();
  const found = new Map();
  for (const dir of [process.env[env], ...siblings.map((n) => path.join(parent, n)), ...extra]) {
    if (!dir || !markers.some((m) => fs.existsSync(path.join(dir, m)))) continue;
    try {
      const real = fs.realpathSync(dir); // a profile linked to another one is the same history
      if (!found.has(real)) found.set(real, dir);
    } catch {
      // vanished while looking
    }
  }
  return [...found.values()];
}

/** One entry per key: a chat that sits in two profiles (a backup, a copy) counts once, in its newest form. */
export function newest(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const old = byKey.get(e.key);
    if (!old || e.mtimeMs > old.mtimeMs) byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

/** A VS Code family User folder and the folder of each profile made in it. */
export function withProfiles(userDir) {
  const profiles = path.join(userDir, 'profiles');
  return [userDir, ...ls(profiles).map((p) => path.join(profiles, p))];
}

/** Where a VS Code family editor keeps its User folder on macOS, Windows and Linux. */
export function appUserDirs(app) {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Application Support', app, 'User'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), app, 'User'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), app, 'User'),
  ];
}

/** Turn a working directory into a display name, or null when it isn't a real project. */
export function projectName(cwd) {
  if (!cwd) return null;
  const p = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '').replace(/[\\/]+$/, '');
  if (p === os.homedir() || p === '') return null;
  if (/scratch-workspaces|^\/private\/|^\/tmp\/|[\\/]Temp[\\/]/.test(p)) return null;
  return path.basename(p);
}

export function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
