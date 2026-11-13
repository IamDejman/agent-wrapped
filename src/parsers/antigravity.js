import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileStamp, fullest, ls, profileDirs, projectName } from '../util.js';

/** Antigravity and Antigravity IDE each keep a folder in ~/.gemini: antigravity, antigravity-ide. */
const roots = () => profileDirs({ name: 'antigravity', marks: ['conversations'], parent: path.join(os.homedir(), '.gemini') });
const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;

/** Top-level fields of a protobuf message, without a schema: [field, value] with numbers for varints and Buffers for bytes. */
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let n = 0;
    let scale = 1;
    for (;;) {
      if (i >= buf.length) throw new RangeError('truncated');
      const b = buf[i++];
      n += (b & 127) * scale;
      if (!(b & 128)) return n;
      scale *= 128;
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const wire = tag % 8;
    const field = Math.floor(tag / 8);
    if (wire === 0) out.push([field, varint()]);
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new RangeError('truncated');
      out.push([field, buf.subarray(i, i + len)]);
      i += len;
    } else throw new RangeError('unknown wire type');
  }
  return out;
}

/** Follows a path of field numbers into nested messages; undefined when any step is missing or unreadable. */
function at(buf, ...pathFields) {
  let cur = buf;
  for (const f of pathFields) {
    if (!Buffer.isBuffer(cur)) return undefined;
    try {
      cur = fields(cur).find((x) => x[0] === f)?.[1];
    } catch {
      return undefined;
    }
  }
  return cur;
}

/** google.protobuf.Timestamp -> ms */
function time(buf) {
  const secs = at(buf, 1);
  return typeof secs === 'number' ? secs * 1000 + Math.floor((at(buf, 2) || 0) / 1e6) : 0;
}

function loadSummaries(DatabaseSync, root, byId) {
  try {
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'), { readOnly: true });
    try {
      const rows = db.prepare('select conversation_id id, nesting_depth depth, parent_conversation_id parent, workspace_uris uris from conversation_summaries').all();
      for (const r of rows) {
        let project = null;
        try {
          const uri = JSON.parse(r.uris)[0];
          if (uri?.startsWith('file://')) project = projectName(fileURLToPath(uri));
        } catch {
          // no usable workspace for this conversation
        }
        byId.set(r.id, { main: !r.depth && !r.parent, project });
      }
    } finally {
      db.close();
    }
  } catch {
    // older installs have no summaries: every conversation counts as a person's own
  }
}

/**
 * Antigravity keeps one SQLite file per conversation under
 * ~/.gemini/antigravity/conversations, with each step and model call stored as
 * a protobuf blob. There is no published schema, so fields are read by number:
 *   steps.metadata        1 = created at, 20.3 = index of the model call that produced the step
 *   steps.step_payload    20.7[] = tool calls, .2 = tool name   (planner responses only)
 *   gen_metadata.data     1.9.4 = started at, 1.19 = model name,
 *                         1.17.2 = usage: 2 input, 3 output, 4 cache write, 5 cache read
 */
let sqlite; // { DatabaseSync, summaries }, loaded once for all conversations

export const antigravity = {
  id: 'antigravity',
  profiles: roots,
  list() {
    return fullest(
      roots().flatMap((root) => {
        const dir = path.join(root, 'conversations');
        return ls(dir)
          .filter((f) => f.endsWith('.db'))
          .map((f) => ({ key: f, file: path.join(dir, f), ...fileStamp(path.join(dir, f)) }));
      }),
    );
  },

  async read({ file }, emit) {
    if (!sqlite) {
      const { DatabaseSync } = await import('node:sqlite');
      sqlite = { DatabaseSync, summaries: new Map() };
      for (const root of roots()) loadSummaries(DatabaseSync, root, sqlite.summaries);
    }
    const session = path.basename(file, '.db');
    const { main = true, project = null } = sqlite.summaries.get(session) ?? {};
    const base = { tool: 'antigravity', session, project, main };
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const callTime = new Map(); // model call index -> time of the first step it produced
      const steps = db.prepare(`select step_type t, metadata m, case when step_type = ${PLANNER_RESPONSE} then step_payload end p from steps where step_type in (${USER_INPUT}, ${PLANNER_RESPONSE}) order by idx`);
      for (const s of steps.iterate()) {
        if (!s.m) continue;
        const meta = Buffer.from(s.m);
        const ts = time(at(meta, 1));
        if (!ts) continue;
        if (s.t === USER_INPUT) {
          if (main) emit({ ...base, ts, kind: 'prompt' });
          continue;
        }
        const call = at(meta, 20, 3) ?? 0;
        if (!callTime.has(call)) callTime.set(call, ts);
        const response = s.p && at(Buffer.from(s.p), 20);
        if (!response) continue;
        for (const [field, value] of fields(response)) {
          const name = field === 7 && at(value, 2);
          if (Buffer.isBuffer(name) && name.length) emit({ ...base, ts, kind: 'tool', name: name.toString('utf8') });
        }
      }

      for (const g of db.prepare('select idx, data from gen_metadata order by idx').iterate()) {
        const gen = at(Buffer.from(g.data), 1);
        const usage = at(gen, 17, 2);
        if (!usage) continue;
        const ts = time(at(gen, 9, 4)) || callTime.get(g.idx);
        if (!ts) continue;
        const u = Object.fromEntries(fields(usage).filter((x) => typeof x[1] === 'number'));
        const model = at(gen, 19);
        emit({
          ...base,
          ts,
          kind: 'reply',
          model: Buffer.isBuffer(model) && model.length ? model.toString('utf8') : null,
          in: u[2] || 0,
          out: u[3] || 0,
          cacheWrite: u[4] || 0,
          cacheRead: u[5] || 0,
        });
      }
    } finally {
      db.close();
    }
  },
};
