#!/usr/bin/env node
/**
 * The percentile server behind `agent-wrapped --compare`. No dependencies.
 *
 *   POST /v1/wraps  { id, year, prompts, tokens, hours, streak, cost }
 *     -> { n, top }   n: wraps for that year, top: the percent of them at or
 *                     above you on each total, or null until there are enough.
 *   GET  /health    -> ok
 *
 * It stores one row per install per year: a random id and five totals. No IP
 * addresses, names, projects, models or dates are kept.
 *
 *   PORT=8787 WRAPS_DB=wraps.db MIN_WRAPS=20 node server/percentiles.js
 *   Behind a proxy, set TRUST_PROXY=1 so rate limits use X-Forwarded-For.
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const FIELDS = ['prompts', 'tokens', 'hours', 'streak', 'cost'];
const MAX = { prompts: 1e9, tokens: 1e15, hours: 8784, streak: 366, cost: 1e9 };
const BODY_LIMIT = 2048;

/** The body as a clean row, or a message saying what is wrong with it. */
function parse(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return 'body must be JSON';
  }
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) return 'id must be 32 hex characters';
  if (!Number.isInteger(body.year) || body.year < 2020 || body.year > 2100) return 'year must be a year';
  for (const f of FIELDS) {
    if (!Number.isInteger(body[f]) || body[f] < 0 || body[f] > MAX[f]) return `${f} must be a whole number from 0 to ${MAX[f]}`;
  }
  return { id: body.id, year: body.year, ...Object.fromEntries(FIELDS.map((f) => [f, body[f]])) };
}

/**
 * Starts the server and resolves to { url, close } once it is listening.
 * `port: 0` picks a free port and `db: ':memory:'` keeps nothing, for tests.
 */
export function start({ port = 8787, host = '0.0.0.0', db = 'wraps.db', minWraps = 20, perHour = 30, trustProxy = false } = {}) {
  const sql = new DatabaseSync(db);
  sql.exec(`CREATE TABLE IF NOT EXISTS wraps (
    id TEXT NOT NULL, year INTEGER NOT NULL,
    prompts INTEGER NOT NULL, tokens INTEGER NOT NULL, hours INTEGER NOT NULL, streak INTEGER NOT NULL, cost INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (id, year)
  )`);
  const upsert = sql.prepare(`INSERT INTO wraps (id, year, ${FIELDS.join(', ')}, updated) VALUES (?, ?, ${FIELDS.map(() => '?').join(', ')}, ?)
    ON CONFLICT (id, year) DO UPDATE SET ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}, updated = excluded.updated`);
  const count = sql.prepare('SELECT COUNT(*) AS n FROM wraps WHERE year = ?');
  const atOrAbove = Object.fromEntries(FIELDS.map((f) => [f, sql.prepare(`SELECT COUNT(*) AS n FROM wraps WHERE year = ? AND ${f} >= ?`)]));

  // Requests per address in the current hour, held in memory only.
  let hits = new Map();
  const timer = setInterval(() => (hits = new Map()), 3_600_000).unref();
  const limited = (req) => {
    const forwarded = trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim();
    const who = forwarded || req.socket.remoteAddress;
    const n = (hits.get(who) ?? 0) + 1;
    hits.set(who, n);
    return n > perHour;
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
    if (pathname !== '/v1/wraps') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    if (limited(req)) return send(res, 429, { error: 'too many requests, try again in an hour' });

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (size > BODY_LIMIT) return send(res, 413, { error: 'body too large' });
      const row = parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof row === 'string') return send(res, 400, { error: row });
      try {
        upsert.run(row.id, row.year, ...FIELDS.map((f) => row[f]), Date.now());
        const { n } = count.get(row.year);
        const top = n < minWraps ? null : Object.fromEntries(FIELDS.map((f) => [f, Math.max(1, Math.ceil((atOrAbove[f].get(row.year, row[f]).n / n) * 100))]));
        send(res, 200, { n, top });
      } catch (err) {
        console.error(err);
        send(res, 500, { error: 'could not save' });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      resolve({
        url: `http://${shown}:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            clearInterval(timer);
            server.close(() => {
              sql.close();
              done();
            });
          }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  start({ port: Number(env.PORT) || 8787, db: env.WRAPS_DB || 'wraps.db', minWraps: Number(env.MIN_WRAPS) || 20, trustProxy: env.TRUST_PROXY === '1' })
    .then(({ url }) => console.log(`Percentile server on ${url}`))
    .catch((err) => {
      console.error(`Could not start: ${err.message}`);
      process.exit(1);
    });
}
