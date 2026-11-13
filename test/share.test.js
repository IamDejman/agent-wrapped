// The share server's pure parts: reading a friend code, drawing the card, the preview page and the PNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync, crc32 } from 'node:zlib';
import { PERSONAS, readCode, readShort, newShort, CARD, cardSvg, advances, page } from '../share/card.js';
import { shortCode } from '../src/compare.js';
import { png } from '../share/png.js';

const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const fonts = {
  display: advances(file('share/fonts/BarlowCondensed-Black.ttf')),
  text: advances(file('share/fonts/Barlow-SemiBold.ttf')),
  bold: advances(file('share/fonts/Barlow-Bold.ttf')),
};
// Made the way the wrap makes it: year, persona number, prompts, tokens, hours, streak, cost.
const codeOf = (...n) => `aw1-${n.map((x) => x.toString(36)).join('.')}`;

test('personas are in the order the wrap numbers them, with the words stats.js gives them', () => {
  const wrap = String(file('src/wrap.html')).match(/const PERSONAS = (\[[^\]]+\])/)[1];
  assert.deepEqual(PERSONAS.map((p) => p.title), JSON.parse(wrap.replaceAll("'", '"')));
  const said = [...String(file('src/stats.js')).matchAll(/is\('([^']+)', '([^']+)'/g)].map(([, title, means]) => ({ title, means }));
  assert.deepEqual(PERSONAS, said);
});

test('a friend code reads back as the totals the wrap put in it', () => {
  const code = codeOf(2026, 6, 4400, 3.4e9, 512, 14, 12300);
  const d = readCode(code.toUpperCase());
  assert.equal(d.code, code);
  assert.equal(d.persona.title, 'The Deep Diver');
  assert.deepEqual([d.year, d.prompts, d.tokens, d.hours, d.streak, d.cost], [2026, 4400, 3.4e9, 512, 14, 12300]);
});

test('anything that is not a friend code is refused', () => {
  for (const bad of [
    '', 'favicon.ico', 'aw1-1ka.6.3e8', codeOf(2026, 0, 1, 1, 1, 1, 1), codeOf(2026, 8, 1, 1, 1, 1, 1),
    codeOf(1999, 1, 1, 1, 1, 1, 1), `${codeOf(2026, 1, 1, 1, 1, 1, 1)}.1`, 'aw1-1ka.1.1.1.1.1.<b>',
    `aw1-1ka.1.1.1.1.1.${'z'.repeat(12)}`,
  ]) assert.equal(readCode(bad), null, bad);
});

test('the card prints the persona, its meaning and the totals for every persona', () => {
  PERSONAS.forEach((p, i) => {
    for (const totals of [[4400, 3.4e9, 512, 14, 12300], [0, 0, 0, 0, 0], [9e6, 9e12, 9e5, 366, 9e8]]) {
      const svg = cardSvg(readCode(codeOf(2026, i + 1, ...totals)), fonts);
      assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
      for (const word of [...p.title.split(' '), ...p.means.split(' ')]) assert.match(svg, new RegExp(`[> ]${word}[ <]`));
    }
  });
  const svg = cardSvg(readCode(codeOf(2026, 6, 4400, 3.4e9, 512, 14, 12300)), fonts);
  for (const value of ['4,400', '3.4B', '14', '$12.3K', 'My 2026 with AI']) assert.ok(svg.includes(`>${value}<`), value);
  assert.ok(cardSvg(readCode(codeOf(2026, 6, 4400, 3.4e9, 512, 14, 0)), fonts).includes('>512<'), 'hours when there is no cost');
});

test('the preview page gives apps the card and sends people on to the site', () => {
  const d = readCode(codeOf(2026, 1, 4400, 3.4e9, 512, 14, 12300));
  const html = page(d, 'https://share.aiyearwrapped.com', 'https://aiyearwrapped.com/');
  assert.ok(html.includes(`<meta property="og:image" content="https://share.aiyearwrapped.com/${d.code}.png">`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(html.includes('<meta property="og:title" content="My 2026 with AI: The Night Shift">'));
  assert.ok(html.includes(`location.replace("https://aiyearwrapped.com/#vs=${d.code}")`));
});

test('a short code reads back however it was typed, and new ones are always readable', () => {
  assert.equal(readShort('K7F2QA'), 'k7f2qa');
  assert.equal(readShort('b0x1y1'), 'b0x1y1');
  assert.equal(readShort('BOXIYL'), 'b0x1y1', 'O reads as 0, I and L as 1');
  for (const bad of ['', 'k7f2q', 'k7f2qab', 'k7f2qu', 'k7f-2q', 'favicon.ico', 'aw1-1ka']) assert.equal(readShort(bad), null, bad);
  for (let i = 0; i < 500; i++) {
    const id = newShort();
    assert.equal(readShort(id), id);
  }
});

test('a card link is eight letters, so it never reads as a friend code', () => {
  assert.equal(readShort('M3QX8T2V', CARD), 'm3qx8t2v');
  for (let i = 0; i < 500; i++) {
    const id = newShort(CARD);
    assert.equal(readShort(id, CARD), id);
    assert.equal(readShort(id), null);
    assert.equal(shortCode(`https://share.aiyearwrapped.com/${id}`), null);
  }
  assert.equal(readShort('k7f2qa', CARD), null);
  assert.ok(String(file('src/wrap.html')).includes(`const CARD = ${/^[0-9a-hjkmnp-tv-z]{8}$/}`), 'the wrap reads card links with the same letters');
});

test('the CLI and the wrap find a code in whatever was pasted, the same way the server reads it', () => {
  const wrap = String(file('src/wrap.html'));
  for (const [pasted, id] of [
    ['k7f2qa', 'k7f2qa'], [' K7F2QA ', 'k7f2qa'], ['Compare with me: npx ai-wrapped-year --vs k7f2qa', 'k7f2qa'],
    ['https://share.aiyearwrapped.com/k7f2qa', 'k7f2qa'], ['https://share.aiyearwrapped.com/k7f2qa?v=2', 'k7f2qa'],
    ['https://aiyearwrapped.com/#vs=k7f2qa', 'k7f2qa'], ['k7f2qa.', 'k7f2qa'], ['nonsense', null], ['', null],
  ]) {
    assert.equal(shortCode(pasted), id, pasted);
    if (id) assert.equal(readShort(id), id);
  }
  assert.ok(wrap.includes(`const SHORT = ${/^[0-9a-hjkmnp-tv-z]{6}$/}`), 'the wrap reads codes with the same letters');
});

test('a card link\'s page shows the card and offers no way to compare with whoever posted it', () => {
  const d = { ...readCode(codeOf(2026, 1, 4400, 3.4e9, 512, 14, 12300)), code: 'm3qx8t2v' };
  const html = page(d, 'https://share.aiyearwrapped.com', 'https://aiyearwrapped.com/');
  assert.ok(html.includes('<meta property="og:image" content="https://share.aiyearwrapped.com/m3qx8t2v.png">'));
  assert.ok(html.includes('location.replace("https://aiyearwrapped.com/")'));
  assert.doesNotMatch(html, /--vs|#vs=|aw1-/);
});

test('the PNG holds the pixels it was given', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255, 9, 9, 9, 255, 7, 7, 7, 255]);
  const out = png(rgba, 3, 2);
  const v = new DataView(out.buffer, out.byteOffset);
  assert.deepEqual([...out.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = {};
  for (let at = 8; at < out.length; ) {
    const length = v.getUint32(at);
    const type = String.fromCharCode(...out.subarray(at + 4, at + 8));
    assert.equal(v.getUint32(at + 8 + length), crc32(out.subarray(at + 4, at + 8 + length)), `${type} checksum`);
    chunks[type] = out.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  assert.deepEqual(Object.keys(chunks), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([...chunks.IHDR], [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  assert.deepEqual([...inflateSync(chunks.IDAT)], [0, ...rgba.subarray(0, 12), 0, ...rgba.subarray(12)]);
});
