// The hive mark (a hexagon ring around a small filled hexagon) drawn straight to PNG, no image libraries.
// Used for the web app's install icons (build-ui.mjs) and the Android launcher icons (mobile/scripts/icons.mjs).
import { deflateSync } from "node:zlib";

export const MARK_BG = [0x11, 0x11, 0x14];
export const MARK_FG = [0x8b, 0x93, 0xff];

/** Signed distance to a pointy-top regular hexagon with inradius r (negative inside). */
function sdHex(x, y, r) {
  // Inigo Quilez's hexagon SDF with x/y swapped (his has flat tops)
  let px = Math.abs(y);
  let py = Math.abs(x);
  const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
  const d = 2 * Math.min(kx * px + ky * py, 0);
  px -= d * kx;
  py -= d * ky;
  px -= Math.max(-kz * r, Math.min(kz * r, px));
  py -= r;
  return Math.hypot(px, py) * Math.sign(py);
}

/**
 * size: pixels. bg: "square" (full bleed: maskable / splash), "rounded" (legacy launcher),
 * "circle" (round launcher) or "none" (transparent: adaptive-icon foreground).
 * mark: hexagon height as a fraction of the size. w/h: canvas (splash screens aren't square).
 */
export function markPng({ size, bg = "rounded", mark = 0.6, w = size, h = size }) {
  const R = (Math.min(w, h) * mark) / 2; // circumradius of the ring
  const r = R * 0.866025404;
  const stroke = R * 0.2;
  const inner = r * 0.36;
  const cx = w / 2, cy = h / 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4); // filter byte 0 (none) + RGBA
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      // coverage of the background shape
      let a = 1;
      if (bg === "none") a = 0;
      else if (bg === "circle") a = clamp01(Math.min(w, h) / 2 - Math.hypot(px, py) + 0.5);
      else if (bg === "rounded") {
        const half = Math.min(w, h) / 2, rad = half * 0.22;
        const qx = Math.max(Math.abs(px) - (half - rad), 0), qy = Math.max(Math.abs(py) - (half - rad), 0);
        a = clamp01(rad - Math.hypot(qx, qy) + 0.5);
      }
      // coverage of the mark: ring + center
      const d = sdHex(px, py, r - stroke / 2);
      const m = Math.max(clamp01(stroke / 2 - Math.abs(d) + 0.5), clamp01(-sdHex(px, py, inner) + 0.5));
      const alpha = m + a * (1 - m);
      const o = 1 + x * 4;
      for (let c = 0; c < 3; c++) row[o + c] = alpha ? Math.round((MARK_FG[c] * m + MARK_BG[c] * a * (1 - m)) / alpha) : 0;
      row[o + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  return png(w, h, Buffer.concat(rows));
}

/** The same mark as SVG (favicon, manifest "any" icon). */
export function markSvg() {
  const hex = (R) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const t = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(32 + R * Math.cos(t)).toFixed(2)},${(32 + R * Math.sin(t)).toFixed(2)}`);
    }
    return pts.join(" ");
  };
  const css = (c) => `rgb(${c.join(" ")})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${css(MARK_BG)}"/><polygon points="${hex(17.3)}" fill="none" stroke="${css(MARK_FG)}" stroke-width="3.8" stroke-linejoin="round"/><polygon points="${hex(6.2)}" fill="${css(MARK_FG)}"/></svg>\n`;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
