import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ls, projectName, safeParse } from '../util.js';

const ROOT = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'amp', 'threads');

/** The folder a thread was opened in, from the first of its workspace trees. */
function workspace(thread) {
  const tree = thread.env?.initial?.trees?.[0];
  if (tree?.fsPath) return tree.fsPath;
  try {
    return fileURLToPath(tree.uri);
  } catch {
    return null;
  }
}

/**
 * Amp: ~/.local/share/amp/threads/T-<id>.json, one file per thread with a
 * messages[] list. A prompt carries the time it was sent, but most replies
 * carry no time and many name no model, so a reply takes the time of the
 * prompt before it and the model of the reply before it. A thread from before
 * Amp recorded models has none, so its tokens are counted and not priced. A
 * thread run by a subagent names its parent in mainThreadID.
 */
export const amp = {
  id: 'amp',
  list: () =>
    ls(ROOT)
      .filter((name) => /^T-.*\.json$/.test(name))
      .map((name) => {
        const file = path.join(ROOT, name);
        const s = fs.statSync(file);
        return { key: name, file, size: s.size, mtimeMs: s.mtimeMs };
      }),

  read({ file }, emit) {
    const thread = safeParse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(thread?.messages)) return;
    const session = thread.id || path.basename(file, '.json');
    const project = projectName(workspace(thread));
    const main = !thread.mainThreadID;
    let ts = thread.created;
    let model = null;

    for (const m of thread.messages) {
      const content = Array.isArray(m.content) ? m.content : [];
      const u = m.usage;
      ts = m.meta?.sentAt || Date.parse(u?.timestamp) || ts;
      if (!ts) continue;
      const base = { tool: 'amp', ts, session, project, main };
      if (m.role === 'user') {
        // A user message made only of tool results hands them back to the model: nobody typed it.
        if (main && content.some((c) => c.type !== 'tool_result')) emit({ ...base, kind: 'prompt' });
        continue;
      }
      if (m.role !== 'assistant') continue;
      for (const c of content) {
        if (c.type === 'tool_use') emit({ ...base, kind: 'tool', name: c.name, id: c.id });
      }
      if (!u) continue;
      model = u.model || model;
      emit({
        ...base,
        kind: 'reply',
        model,
        in: u.inputTokens || 0,
        out: u.outputTokens || 0,
        cacheRead: u.cacheReadInputTokens || 0,
        cacheWrite: u.cacheCreationInputTokens || 0,
      });
    }
  },
};
