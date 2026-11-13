import { PROJECT, at, home, json, jsonl, write } from './setup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compare, friendCodes, totals } from '../src/compare.js';
import fs from 'node:fs';
import { doctor } from '../src/doctor.js';
import { start } from '../server/percentiles.js';

const BIN = fileURLToPath(new URL('../bin/agent-wrapped.js', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// One Claude Code chat, one tool nobody reads yet, and a secret that must never be shown.
const line = (type, extra) => ({ parentUuid: null, isSidechain: false, type, timestamp: '2026-03-02T10:00:00.000Z', sessionId: 's1', cwd: PROJECT, ...extra });
jsonl(at('.claude', 'projects', '-Users-dev-code-alpha', 's1.jsonl'), [
  line('user', { uuid: 'u1', message: { role: 'user', content: 'hello' } }),
  line('assistant', { uuid: 'a1', message: { id: 'msg1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 1000, output_tokens: 500 } } }),
]);
jsonl(at('.kimi-code', 'sessions', 'my-private-project', 'session-123456.jsonl'), [{ type: 'config', secretValue: 'hunter2', nested: { deep: 'also-private' } }]);
json(at('.kimi-code', 'sessions', 'auth.json'), { token: 'hunter3' });

test('the command: logs in, numbers and a page out', () => {
  const data = JSON.parse(run('--year', '2026', '--json'));
  assert.equal(data.totals.prompts, 1);
  assert.equal(data.totals.tokens.total, 1500);
  assert.deepEqual(data.tools.map((t) => t.name), ['Claude Code']);
  assert.equal(data.projects[0].name, 'alpha');

  const out = at('wrap.html');
  run('--year', '2026', '--out', out, '--no-open');
  const page = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', out], { encoding: 'utf8' });
  assert.match(page, /"prompts":1/);
  assert.doesNotMatch(page, /__WRAP_DATA__/);
});

test('the command: usage exports add API-key usage, and a year with nothing says so', () => {
  const csv = write(at('usage.csv'), 'date,model,input_tokens,output_tokens\n2026-04-01,gpt-6-sol,2000,100\n');
  const data = JSON.parse(run('--year', '2026', '--usage', csv, '--json'));
  assert.deepEqual(data.tools.map((t) => [t.name, t.tokens]), [['Claude Code', 1500], ['API', 2100]]);
  assert.equal(data.months.length, 2);

  assert.throws(() => run('--year', '2024', '--json'), /nothing from 2024/);
});

test('the command: export on one machine, import on another', () => {
  const file = at('history.gz');
  run('--export', file);
  const elsewhere = { ...process.env, HOME: at('other-machine'), USERPROFILE: at('other-machine'), AGENT_WRAPPED_HOME: at('other-machine', '.agent-wrapped') };
  const data = JSON.parse(execFileSync(process.execPath, [BIN, '--year', '2026', '--import', file, '--json'], { env: elsewhere, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(data.totals.prompts, 1);
});

test('friends: --vs takes codes from anywhere in what was pasted, and refuses the rest', () => {
  const data = JSON.parse(run('--year', '2026', '--vs', 'Sam=Compare with me: npx ai-wrapped-year --vs AW1-1ka.1.3e8.1kqsbm8.2s.e.9ix', '--vs', 'aw1-1ka.5.8ck.4xqbfzk.ds.1o.2h8n', '--json'));
  assert.deepEqual(data.friends, [
    { name: 'Sam', code: 'aw1-1ka.1.3e8.1kqsbm8.2s.e.9ix' },
    { name: 'Friend 2', code: 'aw1-1ka.5.8ck.4xqbfzk.ds.1o.2h8n' },
  ]);
  assert.throws(() => run('--vs', 'nonsense', '--json'), /not a friend code/);
});

test('friends: a short code or a link to one is looked up, and an aw1- code is read without the network', async () => {
  const asked = [];
  const find = async (code) => (asked.push(code), 'aw1-1ka.1.3e8.1kqsbm8.2s.e.9ix');
  assert.deepEqual(await friendCodes(['Sam=K7F2QA', 'https://aiyearwrapped.com/#vs=b0x1y1', 'aw1-1ka.5.8ck.4xqbfzk.ds.1o.2h8n'], find), [
    { name: 'Sam', code: 'aw1-1ka.1.3e8.1kqsbm8.2s.e.9ix' },
    { name: 'Friend 2', code: 'aw1-1ka.1.3e8.1kqsbm8.2s.e.9ix' },
    { name: 'Friend 3', code: 'aw1-1ka.5.8ck.4xqbfzk.ds.1o.2h8n' },
  ]);
  assert.deepEqual(asked, ['k7f2qa', 'b0x1y1']);
  await assert.rejects(friendCodes(['aw1-1ka.1'], find), /not a friend code/);
});

test('friends: the page numbers personas in the order the wrap names them', () => {
  const stats = fs.readFileSync(new URL('../src/stats.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../src/wrap.html', import.meta.url), 'utf8');
  const named = [...stats.matchAll(/is\('([^']+)'/g)].map((m) => m[1]);
  const listed = JSON.parse(page.match(/const PERSONAS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(listed, named);
});

test('doctor: what was read, and the shape of what was not, without contents', async () => {
  const lines = [];
  await doctor((text) => lines.push(text));
  const report = lines.join('\n');
  assert.match(report, /Claude Code\s+1 file, 2 events, 2026-03-02 to 2026-03-02/);
  assert.match(report, /Codex\s+not found/);
  assert.match(report, /Kimi Code: found, not read yet/);
  assert.match(report, /type=config: .*secretValue/);
  for (const secret of ['hunter2', 'hunter3', 'also-private', 'my-private-project', '123456', 'auth.json']) assert.ok(!report.includes(secret), `${secret} leaked`);
  assert.ok(!report.includes(home));
});

test('percentile server: ranks appear once enough wraps exist', async () => {
  const server = await start({ port: 0, host: '127.0.0.1', db: ':memory:', minWraps: 3 });
  const post = async (body) => {
    const res = await fetch(`${server.url}/v1/wraps`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const wrap = (n, prompts) => ({ id: String(n).repeat(32), year: 2026, prompts, tokens: prompts * 1000, hours: 5, streak: 3, cost: 10 });
  try {
    assert.deepEqual(await post(wrap(1, 10)), [200, { n: 1, top: null }]);
    assert.deepEqual(await post(wrap(2, 20)), [200, { n: 2, top: null }]);
    assert.deepEqual(await post(wrap(2, 25)), [200, { n: 2, top: null }]); // sending again replaces the row
    assert.deepEqual(await post(wrap(3, 30)), [200, { n: 3, top: { prompts: 34, tokens: 34, hours: 100, streak: 100, cost: 100 } }]);
    assert.deepEqual((await post(wrap(1, 10)))[1].top.prompts, 100);
    assert.deepEqual((await post({ ...wrap(4, 1), year: 2027 }))[1], { n: 1, top: null }); // each year ranks on its own

    assert.equal((await post({ ...wrap(1, 10), id: 'me@example.com' }))[0], 400);
    assert.equal((await post({ ...wrap(1, 10), prompts: -1 }))[0], 400);
    assert.equal((await post('not json'))[0], 400);
    assert.equal((await post(JSON.stringify(wrap(1, 10)).padEnd(4000)))[0], 413);
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
    assert.equal((await fetch(`${server.url}/health`)).status, 200);

    // The command's own client: five totals and a random id, nothing else.
    const data = { year: 2026, totals: { prompts: 40, tokens: { total: 9e9 }, activeMs: 7.2e6 }, streak: { days: 9 }, cost: { total: 12.6 }, projects: [{ name: 'alpha' }] };
    assert.deepEqual(totals(data), { year: 2026, prompts: 40, tokens: 9e9, hours: 2, streak: 9, cost: 13 });
    assert.deepEqual(await compare(server.url, data), { n: 4, top: { prompts: 25, tokens: 25, hours: 100, streak: 25, cost: 25 } });
  } finally {
    await server.close();
  }
});

test('percentile server: too many requests from one address are turned away', async () => {
  const server = await start({ port: 0, host: '127.0.0.1', db: ':memory:', perHour: 2 });
  const body = JSON.stringify({ id: 'a'.repeat(32), year: 2026, prompts: 1, tokens: 1, hours: 1, streak: 1, cost: 1 });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${server.url}/v1/wraps`, { method: 'POST', body })).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await server.close();
  }
});
