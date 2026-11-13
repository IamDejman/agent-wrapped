// Turns a friend code into the link preview a post shows: a landscape version of the wrap's share card.
// Pure functions, so the tests run them without the Worker or the image renderer.

// Same order as the wrap's friend codes; the means are the plain words the wrap prints under each name.
export const PERSONAS = [
  ['The Night Shift', 'Works with AI late at night'],
  ['The Dawn Patrol', 'Starts with AI early in the morning'],
  ['The Polyglot', 'Splits the work between AI tools'],
  ['The Weekend Builder', 'Builds on weekends'],
  ['The Juggler', 'Keeps many projects going at once'],
  ['The Deep Diver', 'Puts almost everything into one project'],
  ['The Steady Hand', 'Works at an even pace'],
].map(([title, means]) => ({ title, means }));
const FIELDS = ['prompts', 'tokens', 'hours', 'streak', 'cost'];

// A code is the year, the persona and five totals in base 36. Anything else is refused, so nothing a
// stranger types into the address reaches the image or the page.
export function readCode(text) {
  const code = String(text).toLowerCase();
  if (!/^aw1-[0-9a-z]{1,11}(?:\.[0-9a-z]{1,11}){6}$/.test(code)) return null;
  const [year, persona, ...totals] = code.slice(4).split('.').map((n) => parseInt(n, 36));
  if (year < 2020 || year > 2100 || !PERSONAS[persona - 1] || !totals.every(Number.isSafeInteger)) return null;
  return { code, year, persona: PERSONAS[persona - 1], ...Object.fromEntries(FIELDS.map((f, i) => [f, totals[i]])) };
}

// The wrap's number formats.
const num = (n) => Math.round(n).toLocaleString('en');
const trim = (x) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));
const short = (n) => (n >= 1e9 ? `${trim(n / 1e9)}B` : n >= 1e6 ? `${trim(n / 1e6)}M` : n >= 1e4 ? `${trim(n / 1e3)}K` : num(n));
const money = (n) => (n >= 1e6 ? `$${trim(n / 1e6)}M` : n >= 1e4 ? `$${trim(n / 1e3)}K` : `$${num(n)}`);

export const stats = (d) => [
  [num(d.prompts), 'prompts'],
  [short(d.tokens), 'tokens'],
  [num(d.streak), 'day streak'],
  d.cost >= 1 ? [money(d.cost), 'at API prices'] : [num(d.hours), 'hours'],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Advance widths of printable ASCII, in ems, from a TrueType font's cmap (format 4) and hmtx tables,
// so text can be fitted and wrapped before the renderer sees it.
export function advances(font) {
  const bytes = font instanceof ArrayBuffer ? new Uint8Array(font) : font;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const table = {};
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + i * 16;
    table[String.fromCharCode(...bytes.subarray(at, at + 4))] = v.getUint32(at + 8);
  }
  const em = v.getUint16(table.head + 18);
  const metrics = v.getUint16(table.hhea + 34);
  let sub = 0;
  for (let i = 0; i < v.getUint16(table.cmap + 2); i++) {
    const at = table.cmap + 4 + i * 8;
    if (v.getUint16(at) === 3 && v.getUint16(at + 2) === 1) sub = table.cmap + v.getUint32(at + 4);
  }
  const segs = v.getUint16(sub + 6) / 2;
  const ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, offsets = deltas + segs * 2;
  const glyph = (c) => {
    for (let s = 0; s < segs; s++) {
      if (v.getUint16(ends + s * 2) < c) continue;
      const start = v.getUint16(starts + s * 2);
      if (start > c) return 0;
      const delta = v.getInt16(deltas + s * 2), offset = v.getUint16(offsets + s * 2);
      const g = offset ? v.getUint16(offsets + s * 2 + offset + (c - start) * 2) : c;
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const widths = new Map();
  for (let c = 32; c < 127; c++) widths.set(String.fromCharCode(c), v.getUint16(table.hmtx + 4 * Math.min(glyph(c), metrics - 1)) / em);
  return widths;
}

// Every way to set words on one to three lines, keeping their order.
function splits(words, most = 3) {
  if (most === 1 || words.length === 1) return [[words.join(' ')]];
  const all = [[words.join(' ')]];
  for (let i = 1; i < words.length; i++) {
    for (const rest of splits(words.slice(i), most - 1)) all.push([words.slice(0, i).join(' '), ...rest]);
  }
  return all;
}

// The card: the site's paper, the persona printed twice out of register, its meaning, and four totals.
// fonts: { display, text, bold } advance maps for Barlow Condensed Black, Barlow SemiBold and Barlow Bold.
export function cardSvg(d, fonts) {
  const W = 1200, H = 630, X = 72, COLUMN = 540;
  const paper = '#f7f7f5', ink = '#14205c', blue = '#2438e8', pink = '#ff5c93';
  const width = (str, map, size) => [...str].reduce((w, c) => w + (map.get(c) ?? 0.6), 0) * size;
  const fit = (str, map, max, room) => Math.min(max, (max * room) / width(str, map, max));
  const DISPLAY = 'font-family="Barlow Condensed" font-weight="900"';
  const TEXT = 'font-family="Barlow" font-weight="600"';
  const out = [];
  const text = (x, y, attrs, str) => out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${attrs}>${esc(str)}</text>`);

  text(X, 104, `${TEXT} font-size="40" fill="${ink}"`, `My ${d.year} with AI`);

  // The meaning, wrapped to the left column.
  const means = [];
  for (const word of d.persona.means.split(' ')) {
    const line = means.length ? `${means.at(-1)} ${word}` : word;
    if (means.length && width(line, fonts.text, 32) <= COLUMN) means[means.length - 1] = line;
    else means.push(word);
  }

  // The persona, on whichever lines let it print largest above its meaning: caps 0.7em tall, lines
  // 0.88em apart, under it the pink copy 0.04em lower or a descender 0.2em lower. Its top lines up with
  // the totals and the meaning's last line sits on y=490 at most. A line more has to buy a tenth more size.
  const TOP = 150, GAP = 46;
  const room = 490 - (means.length - 1) * 40 - GAP - TOP;
  const drop = (line) => (/[gjpqy]/.test(line) ? 0.2 : 0.04);
  let best = { size: 0 };
  for (const lines of splits(d.persona.title.split(' '))) {
    const tall = 0.7 + 0.88 * (lines.length - 1) + drop(lines.at(-1));
    const size = Math.min(160, room / tall, ...lines.map((l) => fit(l, fonts.display, 160, COLUMN)));
    const more = lines.length > (best.lines?.length ?? 0) ? 1.1 : 1;
    if (size > best.size * more) best = { size, lines };
  }
  const { size, lines } = best;
  const font = `${DISPLAY} font-size="${size.toFixed(1)}"`;
  let y = TOP + size * 0.7;
  for (const line of lines) {
    text(X + size * 0.05, y + size * 0.04, `${font} fill="${pink}"`, line);
    text(X, y, `${font} fill="${blue}"`, line);
    y += size * 0.88;
  }
  y += GAP + size * (drop(lines.at(-1)) - 0.88);
  for (const line of means) {
    text(X, y, `${TEXT} font-size="32" fill="${ink}"`, line);
    y += 40;
  }

  // Four totals, two by two, on the right.
  const col = 224, left = W - X - 2 * col + 32;
  stats(d).forEach(([value, label], i) => {
    const sx = left + (i % 2) * col;
    const sy = TOP + Math.floor(i / 2) * 196;
    out.push(`<rect x="${sx}" y="${sy}" width="${col - 32}" height="6" fill="${ink}"/>`);
    text(sx, sy + 108, `${DISPLAY} font-size="${fit(value, fonts.display, 100, col - 40).toFixed(1)}" fill="${ink}"`, value);
    text(sx, sy + 150, `${TEXT} font-size="28" fill="${ink}"`, label);
  });

  text(X, H - 64, `font-family="Barlow" font-weight="700" font-size="36" fill="${blue}"`, 'npx ai-wrapped-year');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${paper}"/>${out.join('')}</svg>`;
}

// The page a shared link opens. Apps read the preview from its tags; people are sent on to the site,
// which puts the code in its compare command.
export function page(d, origin, home) {
  const url = `${origin}/${d.code}`;
  const title = `My ${d.year} with AI: ${d.persona.title}`;
  const totals = stats(d).map(([v, l]) => `${v} ${l}`).join(', ');
  const description = `${d.persona.means}. ${totals}. Compare with me: npx ai-wrapped-year --vs ${d.code}`;
  const next = `${home}#vs=${d.code}`;
  const meta = [
    ['name', 'description', description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'AI Wrapped Year'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['property', 'og:image', `${url}.png`],
    ['property', 'og:image:type', 'image/png'],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['property', 'og:image:alt', `${title}. ${d.persona.means}. ${totals}.`],
    ['name', 'twitter:card', 'summary_large_image'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${meta.map(([k, n, c]) => `<meta ${k}="${n}" content="${esc(c)}">`).join('\n')}
<link rel="canonical" href="${esc(url)}">
<script>location.replace(${JSON.stringify(next)})</script>
</head>
<body>
<p><a href="${esc(next)}">${esc(title)}</a></p>
</body>
</html>
`;
}
