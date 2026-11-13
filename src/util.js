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
 * The folders a tool keeps its profiles in. People who use one tool with two
 * accounts (work and personal, say) give each its own copy of the tool's
 * folder and pick one with the tool's environment variable, so that variable
 * only ever names the profile in use right now. This returns the folders it
 * names (a comma-separated list works), then every folder in the home folder
 * whose name starts with the default one (~/.claude, ~/.claude-work), keeping
 * those that hold one of the history folders in marks. A folder reached by
 * two names counts once.
 */
export function profileDirs(env, name, marks) {
  const home = os.homedir();
  const named = (env || '').split(',').map((d) => d.trim()).filter(Boolean);
  const beside = ls(home).filter((n) => n.startsWith(name)).sort().map((n) => path.join(home, n));
  const seen = new Set();
  return [...named, ...beside].filter((dir) => {
    const held = marks.map((m) => path.join(dir, m)).filter((d) => ls(d).length);
    if (!held.length) return false;
    const real = held.map((d) => fs.realpathSync(d)).join('\n');
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** A path with the home folder written as ~, for messages. */
export function tilde(file) {
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
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
