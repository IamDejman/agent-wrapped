import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUserDirs, fileStamp, ls, projectName, safeParse, withProfiles } from '../util.js';

/** Cursor's own database, then one for each profile made in it. */
const databases = () =>
  appUserDirs('Cursor')
    .flatMap((userDir) => withProfiles(userDir).map((dir) => ({ userDir, file: path.join(dir, 'globalStorage', 'state.vscdb') })))
    .filter((d) => fs.existsSync(d.file));
const text = (v) => (typeof v === 'string' ? v : v ? Buffer.from(v).toString('utf8') : '');

/** workspaceStorage/<id>/workspace.json maps Cursor's workspace ids to folders. */
function workspaceFolders(userDir) {
  const map = new Map();
  const root = path.join(userDir, 'workspaceStorage');
  for (const id of ls(root)) {
    try {
      const folder = safeParse(fs.readFileSync(path.join(root, id, 'workspace.json'), 'utf8'))?.folder;
      if (folder?.startsWith('file://')) map.set(id, projectName(fileURLToPath(folder)));
    } catch {
      // unreadable or remote workspace: leave it without a project
    }
  }
  return map;
}

/**
 * Cursor keeps chats in a SQLite key-value table (undocumented, so every read
 * is defensive): composerData:<id> is a conversation, bubbleId:<id>:<n> a message.
 */
export const cursor = {
  id: 'cursor',
  homes: () => databases().map((d) => d.file),
  stamp() {
    const stamps = databases().map((d) => fileStamp(d.file)).filter(Boolean);
    return stamps.length ? stamps.map((s) => `${s.size}:${s.mtimeMs}`).join('|') : null;
  },

  async read(emit) {
    const { DatabaseSync } = await import('node:sqlite');
    const seen = new Set(); // chats already read from another profile
    for (const { userDir, file } of databases()) {
      readDatabase(new DatabaseSync(file, { readOnly: true }), workspaceFolders(userDir), seen, emit);
    }
  },
};

function readDatabase(db, folders, seen, emit) {
  try {
    // A profile that never opened a chat has a database without the chat table.
    if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'cursorDiskKV'").get()) return;
    const headers = new Map();
    try {
      for (const r of db.prepare('select composerId, workspaceId, isSubagent from composerHeaders').iterate()) {
        headers.set(r.composerId, r);
      }
    } catch {
      // older Cursor versions have no composerHeaders table
    }

    const range = (prefix) =>
      db.prepare('select key, value from cursorDiskKV where key >= ? and key < ? and value is not null').iterate(`${prefix}:`, `${prefix};`);

    const composers = new Map();
    for (const { key, value } of range('composerData')) {
      const d = safeParse(text(value));
      if (!d) continue;
      const id = key.slice('composerData:'.length);
      if (seen.has(id)) continue;
      const h = headers.get(id);
      const c = {
        createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.parse(d.createdAt) || 0,
        model: d.modelConfig?.modelName || null,
        project: (h && folders.get(h.workspaceId)) || null,
        main: !(h?.isSubagent || d.isBestOfNSubcomposer),
      };
      composers.set(id, c);
      if (c.createdAt && d.totalLinesAdded > 0) emit({ tool: 'cursor', kind: 'lines', ts: c.createdAt, session: id, n: d.totalLinesAdded });
    }

    for (const { key, value } of range('bubbleId')) {
      const d = safeParse(text(value));
      if (!d) continue;
      const session = key.split(':')[1];
      if (seen.has(session)) continue;
      const c = composers.get(session);
      const ts = Date.parse(d.createdAt) || c?.createdAt;
      if (!ts) continue;
      const base = { tool: 'cursor', ts, session, project: c?.project ?? null, main: c?.main ?? true };

      if (d.type === 1) {
        if (base.main) emit({ ...base, kind: 'prompt' });
      } else if (d.type === 2) {
        if (d.toolFormerData?.name) emit({ ...base, kind: 'tool', name: d.toolFormerData.name });
        emit({
          ...base,
          kind: 'reply',
          model: d.modelInfo?.modelName || c?.model || null,
          in: d.tokenCount?.inputTokens || 0,
          out: d.tokenCount?.outputTokens || 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
    }
    for (const id of composers.keys()) seen.add(id);
  } finally {
    db.close();
  }
}
