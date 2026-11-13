import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ls, safeParse } from './util.js';

/** Bump when a reader changes what it emits, so files that didn't change are read again. */
const VERSION = 1;

export const HOME = process.env.AGENT_WRAPPED_HOME || path.join(os.homedir(), '.agent-wrapped');
const hash = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);

/**
 * A copy of every event the wrap has ever read, kept as one small gzip file
 * per source file or chat: <dir>/<tool>/<hash>.json.gz, with an index beside
 * them. It does three jobs:
 *   - a file that hasn't changed is not parsed again, so reruns are fast
 *   - history a tool later deletes stays in the wrap
 *   - one machine's archive can be exported and imported on another
 * It holds times, counts, model, tool and project names. Never prompt text.
 */
export class Archive {
  constructor(dir = path.join(HOME, 'archive')) {
    this.dir = dir;
    this.indexes = new Map();
    this.dirty = new Set();
  }

  index(tool) {
    let idx = this.indexes.get(tool);
    if (!idx) {
      let text = null;
      try {
        text = fs.readFileSync(path.join(this.dir, tool, 'index.json'), 'utf8');
      } catch {
        // nothing archived for this tool yet
      }
      idx = safeParse(text) ?? {};
      idx.units ??= {};
      this.indexes.set(tool, idx);
    }
    return idx;
  }

  save() {
    for (const tool of this.dirty) {
      const file = path.join(this.dir, tool, 'index.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.indexes.get(tool)));
      fs.renameSync(`${file}.tmp`, file);
    }
    this.dirty.clear();
  }

  load(tool, h) {
    try {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.dir, tool, `${h}.json.gz`))));
    } catch {
      return null;
    }
  }

  store(tool, key, events, meta = {}) {
    const h = hash(key);
    fs.mkdirSync(path.join(this.dir, tool), { recursive: true });
    fs.writeFileSync(path.join(this.dir, tool, `${h}.json.gz`), zlib.gzipSync(JSON.stringify(events), { level: 3 }));
    this.index(tool).units[h] = { key, n: events.length, v: VERSION, ...meta };
    this.dirty.add(tool);
  }

  /** Whether the tool has an archived unit whose key starts with prefix. */
  has(tool, prefix) {
    return Object.values(this.index(tool).units).some((u) => u.key.startsWith(prefix));
  }

  /**
   * Feeds every event of one tool to emit(event, key): read fresh where the
   * source changed, from the archive where it didn't or no longer exists.
   * Returns how many events there were and how many archived units had no source left.
   */
  async run(source, emit, { progress, note } = {}) {
    const tool = source.id;
    const idx = this.index(tool);
    const live = new Set();
    let count = 0;
    let kept = 0;
    const out = (events, key) => {
      for (const ev of events) emit(ev, key);
      count += events.length;
    };

    if (source.list) {
      const entries = source.list();
      const total = entries.reduce((n, e) => n + e.size, 0) || 1;
      let done = 0;
      let failed = 0;
      for (const e of entries) {
        const h = hash(e.key);
        live.add(h);
        const unit = idx.units[h];
        let events = unit && unit.v === VERSION && unit.size === e.size && unit.mtimeMs === e.mtimeMs ? this.load(tool, h) : null;
        if (!events) {
          const fresh = [];
          try {
            await source.read(e, (ev) => fresh.push(ev));
            this.store(tool, e.key, fresh, { size: e.size, mtimeMs: e.mtimeMs });
            events = fresh;
          } catch {
            failed++;
            events = unit ? this.load(tool, h) : null; // the last good read, when there is one
          }
        }
        if (events) out(events, e.key);
        done += e.size;
        progress?.(done / total);
      }
      if (failed) note?.(`${source.name}: ${failed} of ${entries.length} files could not be read and were left out.`);
    } else if (source.stamp) {
      const stamp = source.stamp();
      if (stamp && (stamp !== idx.stamp || idx.v !== VERSION)) {
        const sessions = new Map();
        try {
          await source.read((ev) => {
            const key = ev.session ?? '-';
            if (!sessions.has(key)) sessions.set(key, []);
            sessions.get(key).push(ev);
          });
          for (const [key, events] of sessions) {
            const old = idx.units[hash(key)];
            // A chat with fewer messages than last time was pruned by the tool: keep the fuller copy.
            if (!(old && old.v === VERSION && old.n > events.length)) this.store(tool, key, events);
          }
          idx.stamp = stamp;
          idx.v = VERSION;
          this.dirty.add(tool);
        } catch (err) {
          note?.(`${source.name} skipped: ${err.message}`);
        }
      }
    }

    // Everything else the archive holds: files since deleted, other machines, imported usage.
    for (const [h, unit] of Object.entries(idx.units)) {
      if (live.has(h)) continue;
      const events = this.load(tool, h);
      if (!events) continue;
      out(events, unit.key);
      if (source.list && !unit.key.startsWith('csv:')) kept++;
    }
    this.save();
    return { count, kept };
  }

  /** Writes the whole archive to one gzip file: a header line, then one line per unit. */
  exportTo(file) {
    const lines = [JSON.stringify({ agentWrapped: 1 })];
    for (const tool of ls(this.dir)) {
      for (const [h, unit] of Object.entries(this.index(tool).units)) {
        const events = this.load(tool, h);
        if (events) lines.push(JSON.stringify({ tool, key: unit.key, events }));
      }
    }
    fs.writeFileSync(file, zlib.gzipSync(`${lines.join('\n')}\n`));
    return lines.length - 1;
  }

  /** Merges an export from another machine. A unit already held with as many events is left alone. */
  importFrom(file) {
    const buf = zlib.gunzipSync(fs.readFileSync(file));
    let added = 0;
    let header = false;
    for (let start = 0; start < buf.length; ) {
      const nl = buf.indexOf(10, start);
      const end = nl === -1 ? buf.length : nl;
      const d = safeParse(buf.toString('utf8', start, end));
      start = end + 1;
      if (!header) {
        if (d?.agentWrapped !== 1) throw new Error('not an agent-wrapped export');
        header = true;
        continue;
      }
      if (!d || !/^[a-z]+$/.test(d.tool) || typeof d.key !== 'string' || !Array.isArray(d.events)) continue;
      const old = this.index(d.tool).units[hash(d.key)];
      if (old && old.n >= d.events.length) continue;
      const events = d.events.filter((ev) => ev && typeof ev.ts === 'number' && typeof ev.kind === 'string').map((ev) => ({ ...ev, tool: d.tool }));
      this.store(d.tool, d.key, events);
      added++;
    }
    if (!header) throw new Error('not an agent-wrapped export');
    this.save();
    return added;
  }
}
