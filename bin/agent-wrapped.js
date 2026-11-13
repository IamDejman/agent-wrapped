#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// node:sqlite still announces itself as experimental; that isn't the user's problem.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type !== 'ExperimentalWarning') emitWarning.call(process, warning, ...rest);
};

const { Archive, HOME } = await import('../src/archive.js');
const { SOURCES, unreadTools } = await import('../src/sources.js');
const { Wrap } = await import('../src/stats.js');
const { loadUsageCsv } = await import('../src/usage-csv.js');
const { tilde } = await import('../src/util.js');

const readers = SOURCES.filter((s) => s.read).map((s) => s.name);
const HELP = `ai-wrapped-year: your year with AI coding tools, computed on this machine.

Usage: npx ai-wrapped-year [options]

  --year <yyyy>        Year to wrap (default: this year, or last year during January)
  --usage <file>       Add a usage export (CSV) from an API console: API-key usage that has no local logs
  --cursor-csv <file>  Add the usage export from Cursor's dashboard, for Cursor token counts
  --paid <usd>         What you pay per month across your plans, to compare with list prices
  --github             Add your GitHub activity, through the gh CLI you are signed in to
  --compare            Rank your totals against other wraps (sends five totals to --api)
  --api <url>          Percentile server for --compare (or set AGENT_WRAPPED_API)
  --vs <code>          Compare with a friend's code, from their page (name=code to name them)
  --export <file>      Save this machine's history to one file
  --import <file>      Merge a file made by --export on another machine
  --doctor             Show what was found for each tool, and the layout of tools not read yet
  --out <file>         Where to write the page (default: ~/.agent-wrapped/<year>.html)
  --serve <port>       Serve the page on localhost instead of opening the file
  --json               Print the numbers as JSON and exit
  --data <file>        Render from a saved --json file instead of reading logs
  --no-open            Don't open the browser
  -h, --help           Show this help

Reads ${readers.slice(0, -1).join(', ')} and ${readers.at(-1)}.
Nothing leaves this machine unless you pass --github or --compare.`;

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

let args;
try {
  args = parseArgs({
    options: {
      year: { type: 'string' },
      usage: { type: 'string', multiple: true },
      'cursor-csv': { type: 'string', multiple: true },
      paid: { type: 'string' },
      github: { type: 'boolean' },
      compare: { type: 'boolean' },
      api: { type: 'string' },
      vs: { type: 'string', multiple: true },
      export: { type: 'string' },
      import: { type: 'string', multiple: true },
      doctor: { type: 'boolean' },
      out: { type: 'string' },
      serve: { type: 'string' },
      json: { type: 'boolean' },
      data: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (err) {
  fail(`${err.message}\n\n${HELP}`, 2);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.doctor) {
  const { doctor } = await import('../src/doctor.js');
  await doctor();
  process.exit(0);
}

const now = new Date();
const year = args.year ? Number(args.year) : now.getFullYear() - (now.getMonth() === 0 ? 1 : 0);
if (!Number.isInteger(year)) fail(`--year must be a number, got "${args.year}"`, 2);
const paidPerMonth = args.paid === undefined ? 0 : Number(args.paid);
if (!(paidPerMonth >= 0)) fail(`--paid must be a monthly price in dollars, got "${args.paid}"`, 2);
let friends;
if (args.vs) {
  const { friendCodes } = await import('../src/compare.js');
  try {
    friends = await friendCodes(args.vs);
  } catch (err) {
    fail(err.message, 2);
  }
}

const started = Date.now();
const found = [];

async function readLogs() {
  const status = (text) => process.stderr.isTTY && process.stderr.write(`\r\x1b[K${text}`);
  const notes = [];
  const note = (text) => notes.push(text);
  const archive = new Archive();

  for (const file of args.import ?? []) {
    try {
      note(`Merged ${archive.importFrom(file).toLocaleString('en')} new chats and files from ${file}.`);
    } catch (err) {
      fail(`Could not import ${file}: ${err.message}`);
    }
  }
  for (const [flag, tool] of [['cursor-csv', 'cursor'], ['usage', 'api']]) {
    for (const file of args[flag] ?? []) {
      try {
        archive.store(tool, `csv:${path.basename(file)}`, loadUsageCsv(file, tool));
      } catch (err) {
        fail(`Could not use ${file}: ${err.message}`);
      }
    }
  }

  const wrap = new Wrap(year, { paidPerMonth });
  for (const source of SOURCES) {
    // Cursor's export has the real model calls, so its local replies only count as time spent.
    const exported = source.id === 'cursor' && archive.has('cursor', 'csv:');
    const emit = exported ? (ev, key) => wrap.add(ev.kind === 'reply' && !key.startsWith('csv:') ? { ...ev, kind: 'activity' } : ev) : (ev) => wrap.add(ev);
    status(`Reading ${source.name}`);
    try {
      const { count, kept } = await archive.run(source, emit, { note, progress: (p) => status(`Reading ${source.name} ${Math.floor(p * 100)}%`) });
      if (count) found.push(source.name);
      const profiles = count && source.profiles ? source.profiles() : [];
      if (profiles.length > 1) note(`${source.name}: read ${profiles.length} profiles (${profiles.map(tilde).join(', ')}).`);
      if (count && source.untested) note(`${source.name}: this reader has not been checked against real history yet, so its numbers may be off.`);
      if (kept) note(`${source.name}: ${kept.toLocaleString('en')} files no longer on disk were kept from the archive.`);
    } catch (err) {
      note(`${source.name} skipped: ${err.message}`);
    }
  }
  for (const [name] of unreadTools()) note(`Found ${name} history, which is not read yet. Run with --doctor to see its layout.`);
  status('');
  for (const n of notes) console.error(n);

  if (args.export) {
    try {
      const units = archive.exportTo(args.export);
      console.error(`Saved ${units.toLocaleString('en')} chats and files to ${args.export}\nOn the other machine: npx ai-wrapped-year --import ${path.basename(args.export)}`);
    } catch (err) {
      fail(`Could not write ${args.export}: ${err.message}`);
    }
    process.exit(0);
  }
  if (wrap.empty) {
    fail(found.length ? `Found ${found.join(', ')} history, but nothing from ${year}. It covers ${[...wrap.otherYears].sort().join(', ')}.` : `No AI tool history found on this machine. Looked for ${readers.join(', ')}.`);
  }
  return wrap.finish();
}

let data;
if (args.data) {
  try {
    data = JSON.parse(fs.readFileSync(args.data, 'utf8'));
  } catch (err) {
    fail(`Could not read ${args.data}: ${err.message}`);
  }
} else {
  data = await readLogs();
}

if (friends) data.friends = friends;

if (args.github) {
  try {
    const { githubYear } = await import('../src/github.js');
    data.github = await githubYear(data);
  } catch (err) {
    console.error(`GitHub skipped: ${err.message}`);
  }
}
if (args.compare) {
  const url = args.api ?? process.env.AGENT_WRAPPED_API;
  if (!url) console.error('--compare needs a percentile server: pass --api <url> or set AGENT_WRAPPED_API.');
  else {
    try {
      const { compare } = await import('../src/compare.js');
      data.rank = await compare(url, data);
      if (!data.rank.top) console.error(`Sent. Rankings appear once more people have joined (${data.rank.n} so far).`);
    } catch (err) {
      console.error(`Compare skipped: ${err.message}`);
    }
  }
}

if (args.json) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const templatePath = fileURLToPath(new URL('../src/wrap.html', import.meta.url));
const render = () => fs.readFileSync(templatePath, 'utf8').replace('__WRAP_DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
const out = path.resolve(args.out ?? path.join(HOME, `${data.year}.html`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, render());

if (found.length) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`Wrapped ${data.totals.prompts.toLocaleString('en')} prompts from ${data.tools.map((t) => t.name).join(', ')} in ${secs}s`);
}

const open = (target) => {
  if (args['no-open']) return;
  const [cmd, cmdArgs] =
    process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : ['xdg-open', [target]];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
};

if (args.serve) {
  const port = Number(args.serve);
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(render());
    })
    .on('error', (err) => fail(`Could not serve on port ${port}: ${err.message}`))
    .listen(port, '127.0.0.1', () => {
      console.error(`http://localhost:${port}`);
      open(`http://localhost:${port}`);
    });
} else {
  console.error(out);
  open(out);
}
