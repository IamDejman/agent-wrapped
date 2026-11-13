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

/** A wrap's totals for comparing: aw1- then seven base-36 numbers. Matched anywhere in what was pasted. */
export const FRIEND_CODE = /aw1-[0-9a-z]+(?:\.[0-9a-z]+){6}/i;

/** Keeps friend codes: six letters and digits, each standing for one wrap's totals. */
export const SHARE = 'https://share.aiyearwrapped.com';

/**
 * The friend code in what was pasted: its last word, so the code alone, or a command or link ending in it.
 * O reads as 0, and I and L as 1, since codes leave those letters out.
 */
export function shortCode(text) {
  const word = String(text).replace(/\?.*$/s, '').split(/[^0-9a-z]+/i).filter(Boolean).pop() ?? '';
  const id = word.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
  return /^[0-9a-hjkmnp-tv-z]{6}$/.test(id) ? id : null;
}

/** The totals behind a friend code, as an aw1- code, from the share server. */
export async function lookUp(code) {
  let res;
  try {
    res = await fetch(`${SHARE}/v1/codes/${code}`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`--vs: could not reach ${SHARE} to look up ${code} (${err.cause?.code ?? err.message}).`);
  }
  if (res.status === 404) throw new Error(`--vs: no wrap has the code ${code}. Check it and try again.`);
  if (!res.ok) throw new Error(`--vs: ${SHARE} answered ${res.status} for ${code}.`);
  const totals = (await res.json()).totals?.match?.(FRIEND_CODE)?.[0];
  if (!totals) throw new Error(`--vs: ${SHARE} sent no totals for ${code}.`);
  return totals.toLowerCase();
}

/**
 * --vs values, each a code or name=code, for the page to compare with. Friend codes are looked up on the
 * share server; older aw1- codes are read as they are. Only the page reads the numbers.
 */
export async function friendCodes(values, find = lookUp) {
  return Promise.all(values.map(async (value, i) => {
    const eq = value.indexOf('=');
    const named = eq > 0 && !/[/#:]/.test(value.slice(0, eq)); // a link's #vs= is not a name
    const name = (named ? value.slice(0, eq).trim().slice(0, 24) : '') || `Friend ${i + 1}`;
    const given = named ? value.slice(eq + 1) : value;
    const old = given.match(FRIEND_CODE)?.[0];
    if (old) return { name, code: old.toLowerCase() };
    const code = shortCode(given);
    if (!code) throw new Error(`--vs: "${value}" is not a friend code. Codes are six letters and digits, like k7f2qa, on the Compare slide of a wrap.`);
    return { name, code: await find(code) };
  }));
}
