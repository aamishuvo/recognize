#!/usr/bin/env node
/**
 * Generates the extension's PNG icons. Dev-only: the icons are committed, so
 * loading the extension never needs this script (or Node at all).
 *
 *   node tools/make-icons.cjs
 *
 * Uses only Node's built-in zlib — no image library.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'extension', 'icons');
const BG = [47, 111, 79];      // deep green
const FG = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Rounded square with a centred "+" — the Like control's own glyph. */
function pixel(x, y, size) {
  const r = size * 0.22;                       // corner radius
  const inset = Math.max(1, size * 0.06);
  const lo = inset, hi = size - inset;
  if (x < lo || y < lo || x >= hi || y >= hi) return null;   // transparent margin

  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;    // outside rounded corner

  const mid = size / 2;
  const arm = size * 0.28;                     // half-length of the plus arms
  const thick = Math.max(1, size * 0.09);      // half-thickness
  const inH = Math.abs(y - mid) <= thick && Math.abs(x - mid) <= arm;
  const inV = Math.abs(x - mid) <= thick && Math.abs(y - mid) <= arm;
  return inH || inV ? FG : BG;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                              // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const c = pixel(x + 0.5, y + 0.5, size);
      if (c) { raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]; raw[p++] = 255; }
      else { raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png(size));
  console.log('  wrote extension/icons/icon' + size + '.png');
}
