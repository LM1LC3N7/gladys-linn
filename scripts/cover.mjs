// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a warm dark gradient, a slim
// network player seen from the front (a black glass top, a lit ring and a
// line of light on the display) and sound waves. No logo, no brand mark.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const DARK = [18, 14, 12];
const WARM = [62, 44, 34];
const BODY_TOP = [44, 44, 48];
const BODY = [14, 14, 16];
const EDGE = [120, 120, 128];
const GLOW = [255, 176, 92];
const SOFT = [255, 214, 160];

const BOX = { cx: 360, cy: 290, w: 270, h: 46, r: 10 };
const RING = { x: 170, y: 290, r: 22 };

function pixel(x, y) {
  let color = mix(DARK, WARM, (x / WIDTH) * 0.5 + (1 - y / HEIGHT) * 0.5);
  // Soft shadow under the player.
  const shadow = Math.hypot((x - BOX.cx) / 300, (y - 352) / 14);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.75);
  // The glass top, seen slightly from above.
  const top = roundRect(x, y, BOX.cx, BOX.cy - 56, BOX.w - 14, 12, 8);
  color = mix(color, mix(BODY_TOP, EDGE, (BOX.cy - 56 - y + 12) / 40), inside(top));
  // The front: black, with a thin lit edge.
  const front = roundRect(x, y, BOX.cx, BOX.cy, BOX.w, BOX.h, BOX.r);
  color = mix(color, EDGE, inside(front + 1.5) * 0.6);
  color = mix(color, BODY, inside(front));
  // The ring of light on the left, and its dot.
  const d = Math.hypot(x - RING.x, y - RING.y);
  color = mix(color, GLOW, inside(Math.abs(d - RING.r) - 2.2));
  color = mix(color, GLOW, inside(d - RING.r) * 0.12);
  color = mix(color, SOFT, inside(d - 4));
  // The display: one line of light, a shorter one under it.
  color = mix(color, GLOW, inside(roundRect(x, y, 380, 282, 120, 3, 3)) * 0.95);
  color = mix(color, GLOW, inside(roundRect(x, y, 330, 298, 70, 2, 2)) * 0.6);
  // Sound waves to the right.
  const wx = 640;
  const wd = Math.hypot(x - wx, y - BOX.cy);
  const waveAngle = Math.abs(Math.atan2(y - BOX.cy, x - wx));
  if (x > wx && waveAngle < 0.6) {
    for (const r of [30, 62, 94]) {
      color = mix(color, GLOW, inside(Math.abs(wd - r) - 3.5) * (1 - waveAngle / 0.6) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
