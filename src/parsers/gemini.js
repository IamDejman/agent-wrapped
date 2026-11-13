import fs from 'node:fs';
import path from 'node:path';
import { homes, ls, newest, safeParse } from '../util.js';

/**
 * Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.json, one file per chat
 * with a messages[] list. Written from the published format and not yet
 * checked against real history, so the wrap says so when it uses this reader.
 */
export const gemini = {
  id: 'gemini',
  untested: true,
  homes: () => homes('.gemini', { markers: ['tmp'] }),
  list() {
    const out = [];
    for (const home of this.homes()) {
      const root = path.join(home, 'tmp');
      for (const project of ls(root)) {
        const chats = path.join(root, project, 'chats');
        for (const name of ls(chats)) {
          if (!/^session-.*\.json$/.test(name)) continue;
          const file = path.join(chats, name);
          const s = fs.statSync(file);
          out.push({ key: `${project}/${name}`, file, size: s.size, mtimeMs: s.mtimeMs });
        }
      }
    }
    return newest(out);
  },

  read({ file }, emit) {
    const chat = safeParse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(chat?.messages)) return;
    const session = chat.sessionId || path.basename(file, '.json');

    for (const m of chat.messages) {
      const ts = Date.parse(m.timestamp);
      if (!ts) continue;
      const base = { tool: 'gemini', ts, session, project: null, main: true };
      if (m.type === 'user') emit({ ...base, kind: 'prompt', id: m.id });
      if (m.type !== 'gemini') continue;
      for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (call?.name) emit({ ...base, kind: 'tool', name: call.name, id: call.id });
      }
      const t = m.tokens || {};
      const cached = t.cached || 0;
      emit({
        ...base,
        kind: 'reply',
        id: m.id,
        model: m.model || null,
        in: Math.max(0, (t.input || 0) - cached), // Gemini counts cached tokens inside input
        out: (t.output || 0) + (t.thoughts || 0),
        cacheRead: cached,
        cacheWrite: 0,
      });
    }
  },
};
