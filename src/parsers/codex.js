import path from 'node:path';
import { eachLine, findJsonl, profileDirs, projectName, safeParse } from '../util.js';

const DIRS = ['sessions', 'archived_sessions'];
const MARKERS = [
  'session_meta',
  'turn_context',
  'token_usage_record',
  'token_count',
  'task_started',
  'user_message',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
].map((t) => Buffer.from(`"type":"${t}"`));

const usageEvent = (base, model, u) => {
  const cached = u.cached_input_tokens || 0;
  return {
    ...base,
    kind: 'reply',
    model,
    in: Math.max(0, (u.input_tokens || 0) - cached), // OpenAI counts cached tokens inside input
    out: u.output_tokens || 0,
    cacheRead: cached,
    cacheWrite: u.cache_write_input_tokens || 0,
  };
};

/**
 * Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, moved to
 * ~/.codex/archived_sessions when a chat is archived and later compressed to
 * .jsonl.zst. A rollout keeps its name through both, so the name is its identity.
 * Newer versions write token_usage_record and task_started; older ones only
 * have token_count and user_message events, so both are collected and the
 * newer record wins per file. Every profile is read (see profileDirs).
 */
export const codex = {
  id: 'codex',
  profiles: () => profileDirs(process.env.CODEX_HOME, '.codex', DIRS),
  list() {
    const byName = new Map();
    for (const home of this.profiles()) {
      for (const dir of DIRS) {
        for (const f of findJsonl(path.join(home, dir))) {
          const key = path.basename(f.file).replace(/\.zst$/, '');
          if (!byName.has(key)) byName.set(key, { ...f, key });
        }
      }
    }
    return [...byName.values()];
  },

  async read({ file }, emit) {
    let session = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
    let project = null;
    let model = null;
    let main = true;
    const records = [];
    const counts = [];
    const tasks = [];
    const userMessages = [];

    await eachLine(file, (line) => {
      if (!MARKERS.some((m) => line.includes(m))) return;
      const d = safeParse(line.toString('utf8'));
      const p = d?.payload;
      const ts = Date.parse(d?.timestamp);
      if (!p || !ts) return;
      const base = () => ({ tool: 'codex', ts, session, project, main });

      switch (d.type) {
        case 'session_meta':
          session = p.id || p.session_id || session;
          project = projectName(p.cwd);
          main = !p.parent_thread_id;
          break;
        case 'turn_context':
          model = p.model || model;
          project = projectName(p.cwd) || project;
          break;
        case 'token_usage_record':
          if (p.usage) records.push(usageEvent(base(), model, p.usage));
          break;
        case 'event_msg':
          if (p.type === 'token_count' && p.info?.last_token_usage) counts.push(usageEvent(base(), model, p.info.last_token_usage));
          else if (p.type === 'task_started') tasks.push({ ...base(), kind: 'prompt' });
          else if (p.type === 'user_message') userMessages.push({ ...base(), kind: 'prompt' });
          break;
        case 'response_item':
          if (p.type === 'function_call' || p.type === 'custom_tool_call') emit({ ...base(), kind: 'tool', name: p.name || 'tool' });
          else if (p.type === 'local_shell_call') emit({ ...base(), kind: 'tool', name: 'shell' });
          break;
      }
    });

    if (main) for (const ev of tasks.length ? tasks : userMessages) emit(ev);
    for (const ev of records.length ? records : counts) emit(ev);
  },
};
