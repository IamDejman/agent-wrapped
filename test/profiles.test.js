import { PROJECT, at, collect, jsonl, kinds } from './setup.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { claude } from '../src/parsers/claude.js';
import { codex } from '../src/parsers/codex.js';

const T = '2026-03-02T10:00:00.000Z';
const BIN = path.join(import.meta.dirname, '..', 'bin', 'agent-wrapped.js');

// Claude Code: a default profile, a work profile beside it, and a third somewhere else that only the variable names.
const prompt = (id) => ({ parentUuid: null, isSidechain: false, type: 'user', timestamp: T, sessionId: 's', cwd: PROJECT, uuid: id, message: { role: 'user', content: 'hello' } });
const chat = (dir, name, ids) => jsonl(path.join(dir, 'projects', '-Users-dev-code-alpha', `${name}.jsonl`), ids.map(prompt));
chat(at('.claude'), 'default', ['d1']);
chat(at('.claude-work'), 'work', ['w1']);
chat(at('elsewhere', 'personal'), 'personal', ['p1']);
// One chat copied from the default profile into the work one, where it went on for another prompt.
chat(at('.claude'), 'copied', ['c1']);
chat(at('.claude-work'), 'copied', ['c1', 'c2']);
// Not profiles: a folder with a matching name and no history, and a second name for the work profile.
fs.mkdirSync(at('.claude-worktrees', 'repo'), { recursive: true });
fs.symlinkSync(at('.claude-work'), at('.claude-work-link'));

// Codex: the same, with one rollout present in both profiles.
const rollout = (dir, name, id) =>
  jsonl(path.join(dir, 'sessions', '2026', '03', '02', `${name}.jsonl`), [
    { timestamp: T, type: 'session_meta', payload: { id, cwd: PROJECT } },
    { timestamp: T, type: 'event_msg', payload: { type: 'task_started' } },
  ]);
rollout(at('.codex'), 'rollout-default', 'x1');
rollout(at('.codex-work'), 'rollout-work', 'x2');
rollout(at('.codex'), 'rollout-both', 'x3');
rollout(at('.codex-work'), 'rollout-both', 'x3');
fs.mkdirSync(at('.codexbar'), { recursive: true });

process.env.CLAUDE_CONFIG_DIR = at('elsewhere', 'personal');

test('Claude Code: every profile is read, and a chat held by two is read once', async () => {
  assert.deepEqual(claude.profiles(), [at('elsewhere', 'personal'), at('.claude'), at('.claude-work')]);
  const events = await collect(claude);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.id).sort(), ['c1', 'c2', 'd1', 'p1', 'w1']);
});

test('Claude Code: the profile in use is not read twice when it is also beside the default', async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = at('.claude-work');
  try {
    assert.deepEqual(claude.profiles(), [at('.claude-work'), at('.claude')]);
    assert.deepEqual(kinds(await collect(claude), 'prompt').map((ev) => ev.id).sort(), ['c1', 'c2', 'd1', 'w1']);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test('Codex: every profile is read, and a rollout held by two is read once', async () => {
  assert.deepEqual(codex.profiles(), [at('.codex'), at('.codex-work')]);
  const events = await collect(codex);
  assert.deepEqual(kinds(events, 'prompt').map((ev) => ev.session).sort(), ['x1', 'x2', 'x3']);
});

test('the command: counts every profile and says which ones it read', () => {
  const { stdout, stderr } = spawnSync(process.execPath, [BIN, '--year', '2026', '--json'], { env: process.env, encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).totals.prompts, 8);
  assert.match(stderr, /Claude Code: read 3 profiles \(.*personal, ~.\.claude, ~.\.claude-work\)\./);
  assert.match(stderr, /Codex: read 2 profiles \(~.\.codex, ~.\.codex-work\)\./);
});
