import { PROJECT, at, collect, json, jsonl, kinds, write } from './setup.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { antigravity } from '../src/parsers/antigravity.js';
import { claude } from '../src/parsers/claude.js';
import { codex } from '../src/parsers/codex.js';
import { copilot } from '../src/parsers/copilot.js';
import { cursor } from '../src/parsers/cursor.js';
import { gemini } from '../src/parsers/gemini.js';
import { grok } from '../src/parsers/grok.js';
import { opencode } from '../src/parsers/opencode.js';

const T = '2026-03-02T10:00:00.000Z';
const MS = Date.parse(T);
const later = (secs) => new Date(MS + secs * 1000).toISOString();

function database(file, schema) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(schema);
  return db;
}

test('Claude Code: prompts, split replies, tool calls and subagents', async () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 8 } };
  const line = (type, extra) => ({ parentUuid: null, isSidechain: false, type, timestamp: T, sessionId: 's1', cwd: PROJECT, ...extra });
  const assistant = (id, content, u) => line('assistant', { uuid: `a-${id}-${u.output_tokens}`, message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage: u } });
  jsonl(at('.claude', 'projects', '-Users-dev-code-alpha', 's1.jsonl'), [
    { type: 'summary', summary: 'not a message' },
    line('user', { uuid: 'u1', message: { role: 'user', content: 'hello' } }),
    line('user', { uuid: 'u2', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line('user', { uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    assistant('msg1', [{ type: 'tool_use', id: 'tu1', name: 'Read' }], usage),
    assistant('msg1', [{ type: 'text', text: 'done' }], { ...usage, output_tokens: 50 }),
  ]);
  jsonl(at('.claude', 'projects', '-Users-dev-code-alpha', 's1', 'subagents', 'agent-1.jsonl'), [
    line('user', { uuid: 'u4', isSidechain: true, message: { role: 'user', content: 'a task for the subagent' } }),
    assistant('msg2', [], { input_tokens: 1, output_tokens: 2 }),
  ]);

  const events = await collect(claude);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => [ev.id, ev.project, ev.main]), [['u1', 'alpha', true]]);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['Read']);
  const [reply, sub] = kinds(events, 'reply').sort((a, b) => b.cacheRead - a.cacheRead);
  assert.deepEqual(
    { model: reply.model, in: reply.in, out: reply.out, cacheRead: reply.cacheRead, cacheWrite: reply.cacheWrite, cacheWrite1h: reply.cacheWrite1h, main: reply.main },
    { model: 'claude-opus-5-5', in: 10, out: 50, cacheRead: 100, cacheWrite: 20, cacheWrite1h: 8, main: true },
  );
  assert.equal(sub.main, false);
  assert.equal(sub.out, 2);
});

test('Codex: new and old rollouts, archived and compressed chats', async (t) => {
  const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 };
  const rec = (type, payload, secs = 0) => ({ timestamp: later(secs), type, payload });
  jsonl(at('.codex', 'sessions', '2026', '03', '02', 'rollout-new.jsonl'), [
    rec('session_meta', { id: 'c1', cwd: PROJECT }),
    rec('turn_context', { model: 'gpt-6-sol', cwd: PROJECT }),
    rec('event_msg', { type: 'task_started' }),
    rec('event_msg', { type: 'user_message' }),
    rec('response_item', { type: 'function_call', name: 'shell' }),
    rec('event_msg', { type: 'token_count', info: { last_token_usage: usage } }),
    rec('token_usage_record', { usage }),
  ]);
  const old = [
    rec('session_meta', { id: 'c2', cwd: PROJECT }),
    rec('turn_context', { model: 'gpt-5.5' }),
    rec('event_msg', { type: 'user_message' }),
    rec('event_msg', { type: 'token_count', info: { last_token_usage: usage } }),
  ];
  jsonl(at('.codex', 'archived_sessions', 'rollout-old.jsonl'), old);

  let expected = ['c1', 'c2'];
  if (zlib.zstdCompressSync) {
    const text = old.map((r) => JSON.stringify(r)).join('\n').replace('"c2"', '"c3"');
    write(at('.codex', 'archived_sessions', 'rollout-packed.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(text)));
    expected = ['c1', 'c2', 'c3'];
  } else t.diagnostic('this Node has no zstd, compressed chats not tested');

  const events = await collect(codex);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.session).sort(), expected);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['shell']);
  const replies = kinds(events, 'reply');
  assert.equal(replies.length, expected.length); // the newer usage record replaces the older count, not adds to it
  const first = replies.find((ev) => ev.session === 'c1');
  assert.deepEqual({ model: first.model, in: first.in, out: first.out, cacheRead: first.cacheRead, project: first.project }, { model: 'gpt-6-sol', in: 40, out: 10, cacheRead: 60, project: 'alpha' });
});

test('Grok: turns, tool calls and tokens from context growth', async () => {
  const dir = at('.grok', 'sessions', 'Users-dev-code-alpha', 'g1');
  json(path.join(dir, 'summary.json'), { info: { cwd: PROJECT } });
  jsonl(path.join(dir, 'events.jsonl'), [
    { ts: T, type: 'turn_started', model_id: 'grok-4.6' },
    { ts: later(1), type: 'loop_started' },
    { ts: later(2), type: 'tool_started', tool_name: 'read_file' },
    { ts: later(10), type: 'loop_started' },
    { ts: later(11), type: 'tool_finished', tool_name: 'read_file' },
  ]);
  jsonl(path.join(dir, 'updates.jsonl'), [
    { params: { _meta: { totalTokens: 1000, agentTimestampMs: MS + 3000 } } },
    { params: { _meta: { totalTokens: 1500, agentTimestampMs: MS + 12000 } } },
  ]);

  const events = await collect(grok);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.project), ['alpha']);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['read_file']);
  assert.deepEqual(kinds(events, 'reply').map((ev) => [ev.model, ev.in]), [['grok-4.6', 1000], ['grok-4.6', 500]]);
});

test('Copilot Chat: requests, model and tool calls', async () => {
  const ws = at('.config', 'Code', 'User', 'workspaceStorage', 'ws1');
  json(path.join(ws, 'workspace.json'), { folder: `file://${PROJECT}` });
  json(path.join(ws, 'chatSessions', 'chat1.json'), {
    sessionId: 'cp1',
    requests: [{ requestId: 'r1', timestamp: MS, modelId: 'copilot/gpt-6-sol', response: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_readFile' }] }],
  });

  const events = await collect(copilot);
  assert.deepEqual(events.map((ev) => ev.kind), ['prompt', 'tool', 'reply']);
  assert.deepEqual([events[0].project, events[1].name, events[2].model], ['alpha', 'readFile', 'gpt-6-sol']);
});

test('Gemini CLI: cached tokens are taken out of input', async () => {
  json(at('.gemini', 'tmp', 'proj', 'chats', 'session-1.json'), {
    sessionId: 'gm1',
    messages: [
      { id: 'm1', type: 'user', timestamp: T },
      { id: 'm2', type: 'gemini', timestamp: later(5), model: 'gemini-4-argon', tokens: { input: 100, cached: 40, output: 10, thoughts: 5 }, toolCalls: [{ id: 't1', name: 'read_file' }] },
    ],
  });

  const events = await collect(gemini);
  assert.deepEqual(events.map((ev) => ev.kind), ['prompt', 'tool', 'reply']);
  const reply = events[2];
  assert.deepEqual({ model: reply.model, in: reply.in, out: reply.out, cacheRead: reply.cacheRead }, { model: 'gemini-4-argon', in: 60, out: 15, cacheRead: 40 });
});

test('Cursor: chats from its key-value database', async () => {
  const user = at('.config', 'Cursor', 'User');
  json(path.join(user, 'workspaceStorage', 'w1', 'workspace.json'), { folder: `file://${PROJECT}` });
  const db = database(path.join(user, 'globalStorage', 'state.vscdb'), 'CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, isSubagent INTEGER)');
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?)').run('c1', 'w1', 0);
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  put.run('composerData:c1', JSON.stringify({ createdAt: MS, modelConfig: { modelName: 'claude-sonnet-5' }, totalLinesAdded: 12 }));
  put.run('bubbleId:c1:1', JSON.stringify({ type: 1, createdAt: T }));
  put.run('bubbleId:c1:2', JSON.stringify({ type: 2, createdAt: later(4), toolFormerData: { name: 'edit_file' }, tokenCount: { inputTokens: 5, outputTokens: 7 } }));
  put.run('bubbleId:c1:3', 'not json');
  db.close();

  const events = await collect(cursor);
  assert.deepEqual(kinds(events, 'lines').map((ev) => ev.n), [12]);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.project), ['alpha']);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['edit_file']);
  assert.deepEqual(kinds(events, 'reply').map((ev) => [ev.model, ev.in, ev.out]), [['claude-sonnet-5', 5, 7]]);
});

test('opencode: messages and tool parts from its database', async () => {
  const db = database(
    at('.local', 'share', 'opencode', 'opencode.db'),
    'CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)',
  );
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('o1', PROJECT, null);
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  message.run('m1', 'o1', MS, JSON.stringify({ role: 'user' }));
  message.run('m2', 'o1', MS + 1000, JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-5-5', tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 300, write: 40 } } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p1', 'o1', MS + 500, JSON.stringify({ type: 'tool', tool: 'bash' }));
  db.close();

  const events = await collect(opencode);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.project), ['alpha']);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['bash']);
  const [reply] = kinds(events, 'reply');
  assert.deepEqual({ model: reply.model, in: reply.in, out: reply.out, cacheRead: reply.cacheRead, cacheWrite: reply.cacheWrite }, { model: 'claude-sonnet-5-5', in: 10, out: 25, cacheRead: 300, cacheWrite: 40 });
});

test('Antigravity: steps and usage from protobuf blobs', async () => {
  // A minimal protobuf writer: varint fields and length-delimited fields.
  const varint = (n) => {
    const bytes = [];
    for (; n > 127; n = Math.floor(n / 128)) bytes.push((n % 128) | 128);
    return Buffer.from([...bytes, n]);
  };
  const num = (field, n) => Buffer.concat([varint(field * 8), varint(n)]);
  const sub = (field, ...parts) => {
    const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
    return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
  };
  const secs = MS / 1000;
  const root = at('.gemini', 'antigravity');

  const summaries = database(path.join(root, 'conversation_summaries.db'), 'CREATE TABLE conversation_summaries (conversation_id TEXT, nesting_depth INTEGER, parent_conversation_id TEXT, workspace_uris TEXT)');
  summaries.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run('conv1', 0, null, JSON.stringify([`file://${PROJECT}`]));
  summaries.close();

  const db = database(path.join(root, 'conversations', 'conv1.db'), 'CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB, step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
  const step = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
  step.run(0, 14, sub(1, num(1, secs)), null);
  step.run(1, 15, Buffer.concat([sub(1, num(1, secs + 5)), sub(20, num(3, 0))]), sub(20, sub(7, sub(2, 'view_file')), sub(7, sub(2, 'run_command'))));
  // No start time on the model call, so it takes the time of the step it produced.
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, sub(1, sub(19, 'gemini-4-argon'), sub(17, sub(2, num(2, 100), num(3, 20), num(4, 5), num(5, 300)))));
  db.close();

  const events = await collect(antigravity);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => [ev.project, ev.ts]), [['alpha', MS]]);
  assert.deepEqual(kinds(events, 'tool').map((ev) => ev.name), ['view_file', 'run_command']);
  const [reply] = kinds(events, 'reply');
  assert.deepEqual(
    { ts: reply.ts, model: reply.model, in: reply.in, out: reply.out, cacheWrite: reply.cacheWrite, cacheRead: reply.cacheRead },
    { ts: MS + 5000, model: 'gemini-4-argon', in: 100, out: 20, cacheWrite: 5, cacheRead: 300 },
  );
});

test('Profiles: a second account, a moved home and a copy of the first', async (t) => {
  const prompt = (uuid) => [{ parentUuid: null, isSidechain: false, type: 'user', timestamp: T, sessionId: uuid, cwd: PROJECT, uuid, message: { role: 'user', content: 'hello' } }];
  const chat = ['projects', '-Users-dev-code-alpha', 's9.jsonl'];
  jsonl(at('.claude-work', ...chat), prompt('work'));
  // The same chat in a copy of the folder: the newer file is the one that counts.
  fs.utimesSync(jsonl(at('.claude-backup', ...chat), prompt('stale')), 1, 1);
  jsonl(at('elsewhere', 'projects', '-Users-dev-code-alpha', 's8.jsonl'), prompt('moved'));
  write(at('.claude-worktrees', 'notes.txt'), 'not a profile');
  fs.symlinkSync(at('.claude-work'), at('.claude-link'), 'junction');
  process.env.CLAUDE_CONFIG_DIR = at('elsewhere');
  t.after(() => delete process.env.CLAUDE_CONFIG_DIR);

  assert.equal(claude.homes().length, 4);
  assert.deepEqual(kinds(await collect(claude), 'prompt').map((ev) => ev.id).sort(), ['moved', 'u1', 'work']);
});

test('Profiles: Grok, Gemini CLI and Antigravity folders beside the default', async () => {
  const dir = at('.grok-work', 'sessions', 'Users-dev-code-alpha', 'g2');
  json(path.join(dir, 'summary.json'), { info: { cwd: PROJECT } });
  jsonl(path.join(dir, 'events.jsonl'), [{ ts: T, type: 'turn_started', model_id: 'grok-4.6' }]);
  assert.equal(kinds(await collect(grok), 'prompt').length, 2);

  json(at('.gemini-work', 'tmp', 'proj', 'chats', 'session-2.json'), { sessionId: 'gm2', messages: [{ id: 'm1', type: 'user', timestamp: T }] });
  assert.equal(kinds(await collect(gemini), 'prompt').length, 2);

  database(at('.gemini', 'antigravity-ide', 'conversations', 'conv2.db'), 'CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB, step_payload BLOB)').close();
  fs.mkdirSync(at('.gemini', 'antigravity-backup'));
  assert.deepEqual(antigravity.list().map((e) => e.key).sort(), ['conv1.db', 'conv2.db']);
});

test('Profiles: editor profiles in Cursor and VS Code', async () => {
  const user = at('.config', 'Cursor', 'User');
  const db = database(path.join(user, 'profiles', 'p1', 'globalStorage', 'state.vscdb'), 'CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  for (const id of ['c1', 'c2']) {
    put.run(`composerData:${id}`, JSON.stringify({ createdAt: MS }));
    put.run(`bubbleId:${id}:1`, JSON.stringify({ type: 1, createdAt: T }));
  }
  db.close();
  // A profile that never opened a chat has no chat table.
  database(path.join(user, 'profiles', 'p2', 'globalStorage', 'state.vscdb'), 'CREATE TABLE ItemTable (key TEXT, value BLOB)').close();

  assert.equal(cursor.stamp().split('|').length, 3);
  assert.deepEqual(kinds(await collect(cursor), 'prompt').map((ev) => ev.session), ['c1', 'c2']);

  json(at('.config', 'Code', 'User', 'profiles', 'p1', 'globalStorage', 'emptyWindowChatSessions', 'chat2.json'), { sessionId: 'cp2', requests: [{ requestId: 'r2', timestamp: MS }] });
  assert.deepEqual(kinds(await collect(copilot), 'prompt').map((ev) => ev.project), ['alpha', null]);
});
