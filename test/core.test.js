import { at, write } from './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Archive } from '../src/archive.js';
import { summarise } from '../src/github.js';
import { price } from '../src/pricing.js';
import { Wrap, prettyModel } from '../src/stats.js';
import { loadUsageCsv } from '../src/usage-csv.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const noon = (month, day, year = 2026) => new Date(year, month - 1, day, 12).getTime();
const reply = (ts, extra = {}) => ({ tool: 'claude', kind: 'reply', ts, session: 's1', main: true, model: 'claude-opus-5-5', in: 0, out: 0, cacheRead: 0, cacheWrite: 0, ...extra });
const prompt = (ts, extra = {}) => ({ tool: 'claude', kind: 'prompt', ts, session: 's1', main: true, project: 'alpha', ...extra });

test('usage CSV: an API console export', () => {
  const file = write(at('openai.csv'), 'start_time,model,input_tokens,input_cached_tokens,output_tokens\n2026-01-15T00:00:00Z,gpt-6-sol,1000,400,50\n,gpt-6-sol,1,1,1\n');
  const events = loadUsageCsv(file, 'api');
  assert.equal(events.length, 1); // the row with no date is dropped
  const [ev] = events;
  assert.deepEqual({ tool: ev.tool, kind: ev.kind, model: ev.model, in: ev.in, out: ev.out, cacheRead: ev.cacheRead }, { tool: 'api', kind: 'reply', model: 'gpt-6-sol', in: 600, out: 50, cacheRead: 400 });
  assert.equal(ev.ts, Date.parse('2026-01-15T00:00:00Z'));
});

test('usage CSV: the Cursor dashboard export, quoted numbers and repeated rows', () => {
  const row = '"2026-02-01T10:00:00Z",claude-sonnet-5,"1,200",300,5000,80,6580';
  const file = write(at('cursor.csv'), `﻿Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens\r\n${row}\r\n${row}\r\n`);
  const events = loadUsageCsv(file, 'cursor');
  assert.equal(events.length, 2);
  assert.deepEqual({ in: events[0].in, out: events[0].out, cacheRead: events[0].cacheRead, cacheWrite: events[0].cacheWrite }, { in: 300, out: 80, cacheRead: 5000, cacheWrite: 1200 });
  assert.notEqual(events[0].id, events[1].id); // two identical calls are two calls
});

test('usage CSV: anything else is refused', () => {
  assert.throws(() => loadUsageCsv(write(at('notes.csv'), 'name,comment\nA,B\n'), 'api'), /not a usage export/);
});

test('pricing: list price and what caching saved', () => {
  const cost = price(reply(0, { in: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 4e5 }));
  near(cost.usd, 4 + 0.2 + 0.6 * 5 + 0.4 * 8);
  near(cost.saved, 3.8 - 0.6 * 1 - 0.4 * 4);
  assert.equal(price(reply(0, { model: 'a-model-nobody-priced' })), null);
  assert.equal(price(reply(0, { model: null })), null);
});

test('model names', () => {
  assert.deepEqual(
    ['claude-opus-5-5', 'claude-3-5-sonnet-20241022', 'gpt-6.1-sol', 'gemini-3.8-flash-n', 'grok-4.7-xhigh-fast', 'grok-build', 'something-else', null].map(prettyModel),
    ['Opus 5.5', 'Sonnet 3.5', 'GPT 6.1 Sol', 'Gemini 3.8 Flash', 'Grok 4.7', 'Grok Build', 'something-else', 'Unknown'],
  );
});

test('wrap: totals, months, cost, streak and repeated events', () => {
  const wrap = new Wrap(2026, { paidPerMonth: 100 });
  assert.equal(wrap.empty, true);
  wrap.add(prompt(noon(12, 31, 2025)));
  assert.equal(wrap.empty, true);
  assert.deepEqual([...wrap.otherYears], [2025]);

  wrap.add(prompt(noon(1, 14), { id: 'p1' }));
  wrap.add(prompt(noon(1, 14), { id: 'p1' })); // the same prompt, seen again in a forked chat
  wrap.add(prompt(noon(1, 15), { id: 'p2' }));
  wrap.add(prompt(noon(3, 3), { id: 'p3', project: 'beta' }));
  wrap.add(reply(noon(1, 15), { id: 'r1', in: 1e6, cacheRead: 1e6 }));
  wrap.add(reply(noon(1, 15), { id: 'r1', in: 1e6, cacheRead: 1e6 }));
  wrap.add(reply(noon(3, 3), { id: 'r2', out: 1000, model: 'a-model-nobody-priced' }));
  wrap.add({ tool: 'claude', kind: 'tool', ts: noon(3, 3), name: 'Bash' });
  wrap.add({ tool: 'claude', kind: 'tool', ts: noon(3, 3), name: 'mcp__server__read_file' });

  const data = wrap.finish();
  assert.equal(data.totals.prompts, 3);
  assert.equal(data.totals.replies, 2);
  assert.equal(data.totals.tokens.total, 2e6 + 1000);
  assert.deepEqual(data.months.map((m) => [m.month, m.prompts]), [['2026-01', 2], ['2026-02', 0], ['2026-03', 1]]);
  assert.deepEqual(data.streak, { days: 2, from: '2026-01-14', to: '2026-01-15' });
  near(data.cost.total, 4.2);
  near(data.cost.saved, 3.8);
  assert.equal(data.cost.unpricedTokens, 1000);
  assert.equal(data.cost.topDay.date, '2026-01-15');
  assert.equal(data.cost.paid, 300);
  assert.deepEqual(data.projects, [{ name: 'alpha', prompts: 2 }, { name: 'beta', prompts: 1 }]);
  assert.deepEqual(data.actions.map((a) => a.name).sort(), ['Ran commands', 'Read files']);
  assert.equal(data.tools[0].name, 'Claude Code');
});

test('archive: unchanged files are not read again, deleted ones are kept, machines merge', async () => {
  const file = write(at('logs', 'a.log'), 'one');
  let reads = 0;
  const source = {
    id: 'claude',
    name: 'Claude Code',
    list: () => (fs.existsSync(file) ? [{ key: 'a.log', file, size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }] : []),
    read(entry, emit) {
      reads++;
      emit(prompt(noon(5, 5), { id: 'p1' }));
      emit(reply(noon(5, 5), { id: 'r1', in: 10 }));
    },
  };
  const run = async (dir) => {
    const events = [];
    const result = await new Archive(dir).run(source, (ev) => events.push(ev));
    return { ...result, events };
  };
  const dir = at('archive-a');

  assert.deepEqual([(await run(dir)).count, reads], [2, 1]);
  assert.deepEqual([(await run(dir)).count, reads], [2, 1]);

  fs.rmSync(file);
  const after = await run(dir);
  assert.deepEqual([after.count, after.kept, reads], [2, 1, 1]);
  assert.equal(after.events[1].in, 10);

  const exported = at('export.gz');
  assert.equal(new Archive(dir).exportTo(exported), 1);
  const other = new Archive(at('archive-b'));
  assert.equal(other.importFrom(exported), 1);
  assert.equal(other.importFrom(exported), 0); // already held
  assert.equal((await run(at('archive-b'))).count, 2);
  assert.throws(() => other.importFrom(write(at('junk.gz'), 'not gzip')));
});

test('archive: a file that changed is read again', async () => {
  const file = write(at('logs', 'b.log'), 'one');
  let reads = 0;
  const source = {
    id: 'codex',
    name: 'Codex',
    list: () => [{ key: 'b.log', file, size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }],
    read: (entry, emit) => emit(prompt(noon(5, 5 + reads++))),
  };
  const dir = at('archive-c');
  await new Archive(dir).run(source, () => {});
  fs.writeFileSync(file, 'one, two');
  const events = [];
  await new Archive(dir).run(source, (ev) => events.push(ev));
  assert.equal(reads, 2);
  assert.equal(events.length, 1); // the new read replaces the old one
});

test('GitHub: a year of contributions in a few numbers', () => {
  const day = (date, contributionCount) => ({ date, contributionCount });
  const data = summarise(
    {
      totalCommitContributions: 9,
      totalPullRequestContributions: 2,
      totalPullRequestReviewContributions: 1,
      totalIssueContributions: 0,
      totalRepositoriesWithContributedCommits: 3,
      contributionCalendar: { totalContributions: 12, weeks: [{ contributionDays: [day('2026-01-01', 0), day('2026-01-02', 4)] }, { contributionDays: [day('2026-01-08', 8)] }] },
    },
    { '2026-01-08': 5, '2026-01-09': 1 },
  );
  assert.deepEqual(data, { total: 12, commits: 9, prs: 2, reviews: 1, issues: 0, repos: 3, activeDays: 2, busiest: { date: '2026-01-08', count: 8 }, withAi: 1 });
});
