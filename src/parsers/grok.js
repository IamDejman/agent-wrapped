import fs from 'node:fs';
import path from 'node:path';
import { eachLine, fileStamp, homes, ls, newest, projectName, safeParse } from '../util.js';

const WANTED = ['turn_started', 'loop_started', 'tool_started'].map((t) => Buffer.from(`"type":"${t}"`));
const TOKENS = Buffer.from('"totalTokens"');

/**
 * Grok CLI: ~/.grok/sessions/<working dir>/<session>/ holds events.jsonl
 * (turns, model calls, tool calls) and updates.jsonl. Grok logs no usage per
 * model call, only a running context size, so a call's tokens are what it
 * added to the context: a floor, with nothing counted for re-reading.
 */
export const grok = {
  id: 'grok',
  homes: () => homes('.grok', { env: 'GROK_HOME', markers: ['sessions'] }),
  list() {
    const out = [];
    for (const home of this.homes()) {
      const root = path.join(home, 'sessions');
      for (const cwd of ls(root)) {
        for (const session of ls(path.join(root, cwd))) {
          const dir = path.join(root, cwd, session);
          const events = fileStamp(path.join(dir, 'events.jsonl'));
          if (!events) continue;
          const updates = fileStamp(path.join(dir, 'updates.jsonl'));
          out.push({
            key: `${cwd}/${session}`,
            dir,
            size: events.size + (updates?.size ?? 0),
            mtimeMs: Math.max(events.mtimeMs, updates?.mtimeMs ?? 0),
          });
        }
      }
    }
    return newest(out);
  },

  async read({ dir }, emit) {
    let cwd = null;
    try {
      cwd = safeParse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'))?.info?.cwd ?? null;
    } catch {
      // no summary: the session still counts, without a project
    }
    const base = { tool: 'grok', session: path.basename(dir), project: projectName(cwd), main: true };
    let model = null;
    const calls = []; // [time, model] of each model call

    await eachLine(path.join(dir, 'events.jsonl'), (line) => {
      if (!WANTED.some((w) => line.includes(w))) return;
      const d = safeParse(line.toString('utf8'));
      const ts = Date.parse(d?.ts);
      if (!ts) return;
      if (d.type === 'turn_started') {
        model = d.model_id || model;
        base.main = !d.session_relationship || d.session_relationship === 'primary';
        if (base.main) emit({ ...base, ts, kind: 'prompt' });
      } else if (d.type === 'loop_started') calls.push([ts, model]);
      else if (d.type === 'tool_started' && d.tool_name) emit({ ...base, ts, kind: 'tool', name: d.tool_name });
    });

    const sizes = []; // [time, context size]
    try {
      await eachLine(path.join(dir, 'updates.jsonl'), (line) => {
        if (!line.includes(TOKENS)) return;
        const d = safeParse(line.toString('utf8'));
        const total = d?.params?._meta?.totalTokens;
        const at = d?.params?._meta?.agentTimestampMs ?? (d?.timestamp < 1e12 ? d?.timestamp * 1000 : d?.timestamp);
        if (typeof total === 'number' && at) sizes.push([at, total]);
      });
    } catch {
      // no updates file: calls are still counted, with no tokens
    }

    let i = 0;
    let context = 0;
    calls.forEach(([ts, callModel], n) => {
      const until = calls[n + 1]?.[0] ?? Infinity;
      let added = 0;
      for (; i < sizes.length && sizes[i][0] < until; i++) {
        if (sizes[i][1] > context) added += sizes[i][1] - context;
        context = sizes[i][1]; // drops when the context is compacted
      }
      emit({ ...base, ts, kind: 'reply', model: callModel, in: added, out: 0, cacheRead: 0, cacheWrite: 0 });
    });
  },
};
