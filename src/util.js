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

const STARTUP = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_aliases',
  '.profile',
  '.aliases',
  '.exports',
  '.config/fish/config.fish',
  'Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
  'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1',
];
const LAUNCHERS = ['bin', '.local/bin', '.config/fish/functions', '.local/share/applications'];

/**
 * The folders a variable or flag is given in shell startup files and launcher
 * scripts. An alias or a small wrapper is how a second profile usually gets
 * made (alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'), and
 * nothing else on the machine records where it points. Only the value right
 * after the name is taken from these files.
 */
export function startupValues(name) {
  const home = os.homedir();
  const files = [...STARTUP, ...LAUNCHERS.flatMap((dir) => ls(path.join(home, dir)).map((f) => path.join(dir, f)))];
  const pattern = new RegExp(`${name}(?:\\s*=\\s*|\\s+)("[^"\\n]*"|'[^'\\n]*'|[^\\s;&|)"']+)`, 'g');
  const out = [];
  for (const f of files) {
    let text;
    try {
      const file = path.join(home, f);
      if (fs.statSync(file).size > 1 << 18) continue; // a program, not a script
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [, raw] of text.matchAll(pattern)) {
      const dir = raw
        .replace(/^["']|["']$/g, '')
        .replace(/^~(?=$|[\\/])/, home)
        .replace(/\$\{?HOME\}?|\$env:USERPROFILE/g, home);
      if (path.isAbsolute(dir) && !dir.includes('$')) out.push(dir);
    }
  }
  return out;
}

const HEAVY = /^(node_modules|\.git|\.npm|\.cache|\.cargo|\.rustup|\.nvm|\.pyenv|\.rbenv|\.gradle|\.m2|\.bun|\.yarn|\.pnpm-store|\.docker|\.ollama|\.Trash)$/;

/**
 * Folders at most depth levels below the starting ones that hold one of the
 * folders in marks and pass test, nearest first. It gives up after a fixed
 * number of folders, so one huge tree cannot stall a run, and it does not look
 * inside a folder that passed.
 */
export function search(starts, depth, marks, test, budget = 6000) {
  const found = [];
  let level = starts;
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const dir of level) {
      if (budget-- <= 0) return found;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => marks.includes(e.name)) && test(dir)) found.push(dir);
      else if (d < depth) for (const e of entries) if (e.isDirectory() && !HEAVY.test(e.name)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  return found;
}

/**
 * The folders a tool keeps its profiles in. People who use one tool with two
 * accounts (work and personal, say) give each its own copy of the tool's
 * folder and pick one with the tool's environment variable, so that variable
 * only ever names the profile in use right now. Profiles are looked for in
 * every place they get made:
 *   - the folders the variable names (a comma-separated list works), now and
 *     in shell startup files and launcher scripts
 *   - every folder beside the default one whose name starts the same way
 *     (~/.claude, ~/.claude-work) and that holds one of the folders in marks
 *   - with proof, a stricter check of the tool's own layout: folders a few
 *     levels down in the home folder's dot folders, where account switchers
 *     keep theirs (~/.ccs/instances/work, ~/.claude-profiles/work)
 * A folder reached by two names counts once.
 */
export function profileDirs({ env, name, marks, proof, within = '', parent = os.homedir() }) {
  const named = env
    ? [...(process.env[env] || '').split(','), ...startupValues(env)]
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => path.join(d, within))
    : [];
  const here = ls(parent).sort();
  const beside = here.filter((n) => n.startsWith(name)).map((n) => path.join(parent, n));
  const word = name.replace(/^\./, '');
  const deeper = proof ? search(here.filter((n) => n.startsWith('.') || n.toLowerCase().includes(word)).map((n) => path.join(parent, n)), 3, marks, proof) : [];
  const seen = new Set();
  return [...named, ...beside, ...deeper].filter((dir) => {
    const held = marks.map((m) => path.join(dir, m)).filter((d) => ls(d).length);
    if (!held.length) return false;
    try {
      const real = held.map((d) => fs.realpathSync(d)).join('\n');
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    } catch {
      return false; // vanished while looking
    }
  });
}

/** One entry per key. A chat that sits in two profiles (a copy, a backup) only ever grows, so the larger one has everything. */
export function fullest(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const held = byKey.get(e.key);
    if (!held || e.size > held.size) byKey.set(e.key, e);
  }
  return [...byKey.values()];
}

/** A VS Code family User folder and the folder of each profile made in it. */
export function withProfiles(userDir) {
  const profiles = path.join(userDir, 'profiles');
  return [userDir, ...ls(profiles).map((p) => path.join(profiles, p))];
}

/** A path with the home folder written as ~, for messages. */
export function tilde(file) {
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** Where desktop apps keep their data on macOS, Windows and Linux. */
export function appDataDirs() {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Application Support'),
    process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
  ];
}

/**
 * The User folders of a VS Code family editor: every install named like the
 * app (Code, Code - Insiders, Cursor Nightly) and every folder an alias or
 * launcher passes as --user-data-dir, which is how a second copy of an editor
 * is usually run. Such a folder says nothing about which editor it belongs
 * to, so one with "cursor" in its path goes to Cursor and the rest to Code.
 */
export function appUserDirs(app) {
  const installs = appDataDirs().flatMap((base) =>
    ls(base)
      .filter((n) => n === app || (n.startsWith(app) && /^[ ._-]/.test(n.slice(app.length))))
      .sort()
      .map((n) => path.join(base, n)),
  );
  const launched = app === 'Cursor' || app === 'Code' ? startupValues('--user-data-dir').filter((d) => /cursor/i.test(d) === (app === 'Cursor')) : [];
  return [...new Set([...installs, ...launched])].map((d) => path.join(d, 'User'));
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
