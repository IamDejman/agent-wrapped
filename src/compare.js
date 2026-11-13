import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './archive.js';

/** A random id for this install, so sending again replaces your row instead of adding one. */
function installId() {
  const file = path.join(HOME, 'id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(id)) return id;
  } catch {
    // first run
  }
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, id);
  return id;
}

/** Everything --compare sends: five totals and the year. No names, projects, models or dates. */
export const totals = (data) => ({
  year: data.year,
  prompts: data.totals.prompts,
  tokens: data.totals.tokens.total,
  hours: Math.round(data.totals.activeMs / 3_600_000),
  streak: data.streak.days,
  cost: Math.round(data.cost.total),
});

/** Sends the totals to a percentile server; resolves to { n, top } where top is null until enough wraps exist. */
export async function compare(url, data) {
  const res = await fetch(new URL('/v1/wraps', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: installId(), ...totals(data) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const body = await res.json();
  return { n: Number(body.n) || 0, top: body.top ?? null };
}

/** A friend code as the page shows it: aw1- then seven base-36 numbers. Matched anywhere in what was pasted. */
export const FRIEND_CODE = /aw1-[0-9a-z]+(?:\.[0-9a-z]+){6}/i;

/** --vs values, each a code or name=code, for the page to compare with. Only the page reads the numbers in them. */
export function friendCodes(values) {
  return values.map((value, i) => {
    const eq = value.indexOf('=');
    const code = (eq > 0 ? value.slice(eq + 1) : value).match(FRIEND_CODE)?.[0];
    if (!code) throw new Error(`--vs: "${value}" is not a friend code. Codes start with aw1- and are on the Compare slide of a wrap.`);
    return { name: (eq > 0 ? value.slice(0, eq).trim().slice(0, 24) : '') || `Friend ${i + 1}`, code: code.toLowerCase() };
  });
}
