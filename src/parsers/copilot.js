import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appUserDirs, ls, projectName, fullest, safeParse, withProfiles } from '../util.js';

/**
 * Copilot Chat in VS Code: User/workspaceStorage/<workspace>/chatSessions/<session>.json,
 * one file per chat with a requests[] list. It records when each request was
 * made and, in newer versions, the model and tool calls, but never tokens.
 * Chats in a window with no folder open sit in globalStorage, once per profile.
 */
export const copilot = {
  id: 'copilot',
  list() {
    const out = [];
    const add = (chats, group, workspace) => {
      for (const name of ls(chats)) {
        if (!/\.jsonl?$/.test(name)) continue;
        const file = path.join(chats, name);
        const s = fs.statSync(file);
        out.push({ key: `${group}/${name}`, file, workspace, size: s.size, mtimeMs: s.mtimeMs });
      }
    };
    for (const app of ['Code', 'VSCodium']) {
      for (const userDir of appUserDirs(app)) {
        const root = path.join(userDir, 'workspaceStorage');
        for (const ws of ls(root)) add(path.join(root, ws, 'chatSessions'), ws, path.join(root, ws));
        for (const dir of withProfiles(userDir)) add(path.join(dir, 'globalStorage', 'emptyWindowChatSessions'), 'empty', null);
      }
    }
    return fullest(out);
  },

  read({ file, workspace }, emit) {
    const text = fs.readFileSync(file, 'utf8');
    // .jsonl sessions start with a snapshot line; later lines are edits to it.
    const first = file.endsWith('.jsonl') ? safeParse(text.split('\n', 1)[0]) : safeParse(text);
    const chat = first?.requests ? first : first?.v;
    if (!Array.isArray(chat?.requests)) return;

    let project = null;
    try {
      const folder = workspace && safeParse(fs.readFileSync(path.join(workspace, 'workspace.json'), 'utf8'))?.folder;
      if (folder?.startsWith('file://')) project = projectName(fileURLToPath(folder));
    } catch {
      // no folder for this workspace
    }
    const session = chat.sessionId || path.basename(file).replace(/\.jsonl?$/, '');

    for (const r of chat.requests) {
      const ts = Number(r.timestamp);
      if (!ts) continue;
      const base = { tool: 'copilot', ts, session, project, main: true };
      emit({ ...base, kind: 'prompt', id: r.requestId });
      for (const part of Array.isArray(r.response) ? r.response : []) {
        if (part?.kind === 'toolInvocationSerialized' && part.toolId) emit({ ...base, kind: 'tool', name: part.toolId.replace(/^copilot_/, '') });
      }
      const model = typeof r.modelId === 'string' ? r.modelId.replace(/^copilot\//, '') : null;
      emit({ ...base, kind: 'reply', id: r.requestId, model, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    }
  },
};
