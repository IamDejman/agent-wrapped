// A PNG from the renderer's RGBA pixels. The renderer's own encoder compresses hard and takes twice as
// long as the drawing; the fastest deflate keeps a card near 60KB and inside the Worker's CPU budget.
import { deflateSync } from 'node:zlib';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

export function png(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height); // each row starts with filter 0, none
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const head = new Uint8Array(13);
  const v = new DataView(head.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  head.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [SIGNATURE, chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}
