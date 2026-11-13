import os from 'node:os';
import path from 'node:path';
import { fileStamp, projectName, safeParse } from '../util.js';

const DB = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');

/**
 * opencode keeps every chat in one SQLite file, with each message and part
 * stored as JSON in a data column. Written from the published format and not
 * yet checked against real history, so the wrap says so when it uses this reader.
 */
export const opencode = {
  id: 'opencode',
  untested: true,
  stamp() {
    const s = fileStamp(DB);
    return s && `${s.size}:${s.mtimeMs}`;
  },

  async read(emit) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    try {
      const sessions = new Map();
      for (const s of db.prepare('select id, directory, parent_id from session').iterate()) {
        sessions.set(s.id, { project: projectName(s.directory), main: !s.parent_id });
      }
      const base = (row) => {
        const s = sessions.get(row.session_id);
        return { tool: 'opencode', ts: row.time_created, session: row.session_id, project: s?.project ?? null, main: s?.main ?? true };
      };

      for (const row of db.prepare('select id, session_id, time_created, data from message').iterate()) {
        const d = safeParse(row.data);
        if (!d || !row.time_created) continue;
        const b = base(row);
        if (d.role === 'user') {
          if (b.main) emit({ ...b, kind: 'prompt', id: row.id });
        } else if (d.role === 'assistant') {
          const t = d.tokens || {};
          emit({
            ...b,
            kind: 'reply',
            id: row.id,
            model: d.modelID || null,
            in: t.input || 0,
            out: (t.output || 0) + (t.reasoning || 0),
            cacheRead: t.cache?.read || 0,
            cacheWrite: t.cache?.write || 0,
          });
        }
      }

      for (const row of db.prepare('select id, session_id, time_created, data from part').iterate()) {
        const d = safeParse(row.data);
        if (d?.type === 'tool' && d.tool && row.time_created) emit({ ...base(row), kind: 'tool', name: d.tool, id: row.id });
      }
    } finally {
      db.close();
    }
  },
};
