// share.aiyearwrapped.com: friend codes, and the link a wrap's share buttons post.
//   POST /v1/codes         an aw1- code in, the short code for those totals out (the same one every time)
//   GET  /v1/codes/<code>  the totals behind a short code, for the wrap's Compare slide and --vs
//   /<code>                a page whose tags give apps the card as the link preview, then sends people to the site
//   /<code>.png            the card, drawn once per code and kept in the cache
// <code> is a short code, or an aw1- code from links posted before short codes. Anything else goes to the site.
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import display from './fonts/BarlowCondensed-Black.ttf';
import text from './fonts/Barlow-SemiBold.ttf';
import bold from './fonts/Barlow-Bold.ttf';
import { readCode, readShort, newShort, cardSvg, advances, page } from './card.js';
import { png } from './png.js';

const HOME = 'https://aiyearwrapped.com/';
const fontBuffers = [display, text, bold].map((f) => new Uint8Array(f));
const widths = { display: advances(display), text: advances(text), bold: advances(bold) };
let ready;

async function draw(d) {
  await (ready ??= initWasm(wasm));
  const resvg = new Resvg(cardSvg(d, widths), { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Barlow' } });
  const image = resvg.render();
  try {
    return png(image.pixels, image.width, image.height);
  } finally {
    image.free();
    resvg.free();
  }
}

// The short code for some totals: the one they already have, or a new one. A new code that is already
// taken inserts nothing, so it tries again with another.
async function shorten(db, totals) {
  const find = db.prepare('SELECT id FROM codes WHERE totals = ?').bind(totals);
  for (let tries = 0; ; tries++) {
    const id = await find.first('id');
    if (id || tries === 3) return id;
    await db.prepare('INSERT INTO codes (id, totals) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(newShort(), totals).run();
  }
}

// What a link names: an aw1- code read as it is, or a short code looked up. Either way, d.code is the name.
async function lookUp(db, name) {
  const old = readCode(name);
  if (old) return old;
  const totals = await db.prepare('SELECT totals FROM codes WHERE id = ?').bind(name).first('totals');
  const d = totals && readCode(totals);
  return d ? { ...d, totals: d.code, code: name } : null;
}

// The wrap is a file on someone's computer, so the API answers any origin.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

async function api(request, env, path) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
  try {
    if (path === '/v1/codes' && request.method === 'POST') {
      const by = request.headers.get('cf-connecting-ip') ?? '';
      if (!(await env.MAKING.limit({ key: by })).success) return json({ error: 'Too many codes from here. Try again in a minute.' }, 429);
      if (Number(request.headers.get('content-length')) > 200) return json({ error: 'Send one aw1- code.' }, 413);
      const d = readCode((await request.text()).trim());
      if (!d) return json({ error: 'Send one aw1- code.' }, 400);
      const code = await shorten(env.DB, d.code);
      return code ? json({ code }) : json({ error: 'No code is free. Try again.' }, 503);
    }
    const [, name] = path.match(/^\/v1\/codes\/([^/]+)$/) ?? [];
    if (name && request.method === 'GET') {
      const id = readShort(name);
      const d = id && (await lookUp(env.DB, id));
      return d ? json({ code: id, totals: d.totals }) : json({ error: 'No wrap has that code.' }, 404);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    console.error('api failed', path, err);
    return json({ error: 'The share server failed. Try again.' }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) return api(request, env, url.pathname);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    // Crawlers that ask first, as X's does, are welcome everywhere.
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=86400' } });
    }
    const [, given, image] = url.pathname.match(/^\/([^/]+?)(\.png)?$/) ?? [];
    const name = given && (readCode(given)?.code ?? readShort(given));
    if (!name) return Response.redirect(HOME, 302);

    if (!image) {
      const d = await lookUp(env.DB, name);
      if (!d) return Response.redirect(HOME, 302);
      const html = page(d, url.origin, HOME);
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=86400' };
      return new Response(request.method === 'HEAD' ? null : html, { headers });
    }

    // A code's totals never change, so its card is drawn once.
    const key = new Request(`${url.origin}/${name}.png`);
    let res = await caches.default.match(key);
    if (!res) {
      const d = await lookUp(env.DB, name);
      if (!d) return Response.redirect(HOME, 302);
      try {
        const headers = { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' };
        res = new Response(await draw(d), { headers });
      } catch (err) {
        console.error('card failed', name, err);
        return new Response('The card could not be drawn.', { status: 500 });
      }
      ctx.waitUntil(caches.default.put(key, res.clone()));
    }
    return request.method === 'HEAD' ? new Response(null, res) : res;
  },
};
