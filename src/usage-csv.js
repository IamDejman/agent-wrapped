import fs from 'node:fs';

/** RFC 4180 rows: quoted fields may hold commas, newlines and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

// Every provider names its columns differently and renames them over time, so
// headers are matched loosely. First match wins; several columns may feed one
// field (two cache-write columns, say) and are added up.
const COLUMNS = [
  ['in', /w\/o\s*cache write/i],
  ['cacheWrite', /w\/\s*cache write/i],
  ['cacheWrite', /cache.*(write|creat)/i],
  ['cacheRead', /cache.*read|cached/i],
  ['out', /output|completion/i],
  ['in', /input|prompt/i],
  ['total', /^(total[ _])?tokens$/i],
  ['date', /^(date|day|time|timestamp|start[ _]?time|starting[ _]?at|usage[ _]?date)/i],
  ['model', /^model/i],
];

const time = (value) => {
  const v = (value ?? '').trim();
  if (/^\d{10}$/.test(v)) return Number(v) * 1000;
  if (/^\d{13}$/.test(v)) return Number(v);
  return Date.parse(v) || 0;
};

/**
 * A usage export: a CSV with a date, a model and token counts on each row,
 * such as the one from Cursor's dashboard or a provider's API console. This is
 * how usage with no local logs gets into the wrap: API keys used from your own
 * code, or months a tool has already deleted. Returns reply events for `tool`;
 * throws with a readable message when the file isn't one.
 */
export function loadUsageCsv(file, tool) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const header = (rows.shift() ?? []).map((h) => h.trim());
  const col = { in: [], out: [], cacheRead: [], cacheWrite: [], total: [], date: [], model: [] };
  header.forEach((h, i) => {
    const field = COLUMNS.find(([, re]) => re.test(h))?.[0];
    if (field) col[field].push(i);
  });
  if (!col.date.length || !col.model.length || !(col.out.length || col.total.length)) {
    throw new Error('not a usage export (expected a date, a model and token columns)');
  }
  const sum = (row, cols) => cols.reduce((n, i) => n + (Number((row[i] ?? '').replace(/[^\d]/g, '')) || 0), 0);
  // "input_cached_tokens" style columns are a part of input, not an addition to it.
  const cachedInsideInput = col.cacheRead.some((i) => /input/i.test(header[i]));

  const events = [];
  const seen = new Map();
  for (const row of rows) {
    const ts = time(row[col.date[0]]);
    if (!ts) continue;
    const cacheRead = sum(row, col.cacheRead);
    const ev = {
      tool,
      kind: 'reply',
      ts,
      session: null,
      project: null,
      main: false,
      model: row[col.model[0]]?.trim() || null,
      in: Math.max(0, sum(row, col.in) - (cachedInsideInput ? cacheRead : 0)),
      out: sum(row, col.out),
      cacheRead,
      cacheWrite: sum(row, col.cacheWrite),
    };
    // Older exports only have a single token total.
    if (!(ev.in + ev.out + ev.cacheRead + ev.cacheWrite)) ev.in = sum(row, col.total);
    if (!(ev.in + ev.out + ev.cacheRead + ev.cacheWrite)) continue;
    // Two exports that overlap in time repeat rows; the id lets the wrap count each once.
    const row_ = `${ts}:${ev.model}:${ev.in}:${ev.out}:${ev.cacheRead}:${ev.cacheWrite}`;
    const nth = (seen.get(row_) || 0) + 1;
    seen.set(row_, nth);
    ev.id = `${row_}:${nth}`;
    events.push(ev);
  }
  return events;
}
