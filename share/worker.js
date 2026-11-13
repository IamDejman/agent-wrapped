// share.aiyearwrapped.com: the link a wrap's share buttons post.
//   /<code>      a page whose tags give apps the card as the link preview, then sends people to the site
//   /<code>.png  the card, drawn once per code and kept in the cache
// Anything else goes to the site.
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import display from './fonts/BarlowCondensed-Black.ttf';
import text from './fonts/Barlow-SemiBold.ttf';
import bold from './fonts/Barlow-Bold.ttf';
import { readCode, cardSvg, advances, page } from './card.js';
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

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const [, name, image] = url.pathname.match(/^\/([^/]+?)(\.png)?$/) ?? [];
    const d = name && readCode(name);
    if (!d) return Response.redirect(HOME, 302);

    if (!image) {
      const html = page(d, url.origin, HOME);
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=86400' };
      return new Response(request.method === 'HEAD' ? null : html, { headers });
    }

    const key = new Request(`${url.origin}/${d.code}.png`);
    let res = await caches.default.match(key);
    if (!res) {
      try {
        const headers = { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' };
        res = new Response(await draw(d), { headers });
      } catch (err) {
        console.error('card failed', d.code, err);
        return new Response('The card could not be drawn.', { status: 500 });
      }
      ctx.waitUntil(caches.default.put(key, res.clone()));
    }
    return request.method === 'HEAD' ? new Response(null, res) : res;
  },
};
