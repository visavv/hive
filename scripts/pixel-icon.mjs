// The hive app icon as pixel art: a honeycomb cell with a bee, drawn on a 32×32 grid and
// scaled up with hard edges. Writes assets/hive.png (256 px), assets/hive-512.png and
// assets/hive.ico (16–256 px, PNG-in-ICO). No image libraries: run `node scripts/pixel-icon.mjs`.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PALETTE = {
  ".": null, // transparent
  o: [0x4a, 0x2a, 0x08], // cell outline (dark honey)
  h: [0xe0, 0x8e, 0x12], // honey
  l: [0xff, 0xb9, 0x3d], // honey light
  s: [0xff, 0xe0, 0x8a], // shine
  d: [0xb0, 0x66, 0x0c], // honey shadow
  k: [0x1b, 0x16, 0x14], // bee outline / stripes
  y: [0xff, 0xd8, 0x3b], // bee yellow
  w: [0xf2, 0xf8, 0xff], // wing
  b: [0x9e, 0xc4, 0xee], // wing shade
  e: [0xff, 0xff, 0xff], // eye glint
};

const N = 32;

/** The 32×32 sprite as rows of palette keys. */
export function sprite() {
  const g = Array.from({ length: N }, () => Array(N).fill("."));
  // honeycomb cell: pointy-top hexagon, sampled at pixel centres (crisp, no anti-aliasing)
  const cx = 14.5, cy = 15.5, R = 13.2;
  const inHex = (x, y, r) => {
    const px = Math.abs(x - cx), py = Math.abs(y - cy);
    return px <= r * 0.866 && py <= r - px * 0.57735;
  };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const X = x + 0.5, Y = y + 0.5;
      if (!inHex(X, Y, R)) continue;
      if (!inHex(X, Y, R - 1.25)) g[y][x] = "o";
      else if (!inHex(X, Y, R - 2.6)) g[y][x] = X - cx + (Y - cy) * 0.6 < -2 ? "l" : "h";
      else g[y][x] = Y - cy > 4 ? "d" : "h";
    }
  // inner cell wall: a smaller hexagon ring (the comb's depth)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const X = x + 0.5, Y = y + 0.5;
      if (inHex(X, Y, 7.4) && !inHex(X, Y, 6.2)) g[y][x] = "d";
    }
  // shine in the top-left
  for (const [x, y] of [[7, 8], [8, 7], [9, 6], [7, 9], [6, 10], [10, 6]]) g[y][x] = "s";

  // bee, flying in from the bottom right
  const bee = [
    "......ww.ww......",
    ".....wbbwbbw..k..",
    ".....wbbwbbw.k...",
    "......wwkww..k...",
    "...kkkkkkkkkkkk..",
    "..kyykkyykkykkkk.",
    ".kyyykkyykkykkeek",
    "kkyyykkyykkykkkkk",
    ".kyyykkyykkykkkk.",
    "..kyykkyykkykkk..",
    "...kkkkkkkkkkk...",
    "....k..k..k......",
  ];
  const ox = 14, oy = 18;
  bee.forEach((row, j) =>
    [...row].forEach((c, i) => {
      if (c !== "." && oy + j < N && ox + i < N) g[oy + j][ox + i] = c;
    }),
  );
  return g.map((r) => r.join(""));
}

// ---- PNG / ICO encoding ----

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** The sprite scaled to `size` px (nearest neighbour) as a PNG. */
export function iconPng(size, rows = sprite()) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const c = PALETTE[rows[Math.floor((y * N) / size)][Math.floor((x * N) / size)]];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (c) {
        raw[o] = c[0];
        raw[o + 1] = c[1];
        raw[o + 2] = c[2];
        raw[o + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A Windows .ico holding PNG images (Vista+). */
export function iconIco(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map((s) => iconPng(s));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...pngs]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "hive.png"), iconPng(256));
  writeFileSync(join(out, "hive-512.png"), iconPng(512));
  writeFileSync(join(out, "hive.ico"), iconIco());
  console.log(`wrote ${out}/hive.png, hive-512.png, hive.ico`);
}
