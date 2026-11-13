import os from 'node:os';
import path from 'node:path';
import { eachLine, findJsonl, projectName, safeParse } from '../util.js';

const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const TOOL_RESULT = Buffer.from('"type":"tool_result"');

/**
 * Claude Code transcripts: ~/.claude/projects/<project>/<session>.jsonl, with
 * subagent and workflow transcripts nested one or more folders deeper.
 * Most bytes are tool results and request blobs, so lines are filtered on
 * their raw prefix before any JSON.parse. Forked sessions repeat history, so
 * every event carries the id of its message for the wrap to count once.
 */
export const claude = {
  id: 'claude',
  list: () => findJsonl(ROOT).map((f) => ({ ...f, key: path.relative(ROOT, f.file) })),

  async read({ file, depth }, emit) {
    const mainFile = depth === 1;
    let cur = null; // assistant message being assembled: one message is split over several lines

    const flush = () => {
      if (cur) emit(cur.ev);
      cur = null;
    };

    await eachLine(file, (line) => {
      const head = line.toString('latin1', 0, 400);
      // Bookkeeping records start with {"type":...; messages start with {"parentUuid":...
      if (head.startsWith('{"type":"') && !/^\{"type":"(user|assistant)"/.test(head)) return;
      if (head.includes('"attachment":{')) return;
      if (head.includes('"type":"user"') && line.includes(TOOL_RESULT)) return;

      const d = safeParse(line.toString('utf8'));
      if (!d || (d.type !== 'user' && d.type !== 'assistant')) return;
      const ts = Date.parse(d.timestamp);
      if (!ts) return;
      const base = {
        tool: 'claude',
        ts,
        session: d.sessionId,
        project: projectName(d.cwd),
        // sdk-* entrypoints are scripts calling Claude Code, not a person typing
        main: mainFile && !d.isSidechain && !d.entrypoint?.startsWith('sdk-'),
      };

      if (d.type === 'user') {
        if (!base.main || d.isMeta) return;
        if (d.promptSource === 'system' || (d.origin && d.origin.kind !== 'human')) return;
        if (!d.origin) {
          // Older logs carry no origin: drop injected command output and notifications.
          const c = d.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : '';
          if (text.startsWith('<')) return;
        }
        emit({ ...base, kind: 'prompt', id: d.uuid });
        return;
      }

      const m = d.message;
      if (!m || !m.id || m.model === '<synthetic>') return;
      for (const b of m.content || []) {
        if (b.type === 'tool_use') emit({ ...base, kind: 'tool', name: b.name, id: b.id });
      }
      const u = m.usage || {};
      if (cur && cur.ev.id === m.id) {
        // Later lines of the same message carry the final output count.
        cur.ev.out = Math.max(cur.ev.out, u.output_tokens || 0);
        cur.ev.thinkMs = Math.max(cur.ev.thinkMs, d.thinkingDurationMs || 0); // repeated on every line
        return;
      }
      flush();
      cur = {
        ev: {
          ...base,
          kind: 'reply',
          id: m.id,
          model: m.model,
          in: u.input_tokens || 0,
          out: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens || 0, // the part of cacheWrite billed at the 1 hour rate
          thinkMs: d.thinkingDurationMs || 0,
        },
      };
    });
    flush();
  },
};
