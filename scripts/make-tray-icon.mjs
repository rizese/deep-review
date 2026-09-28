#!/usr/bin/env node
/**
 * Turn the flat mark into the icons the menu bar wants.
 *
 * macOS menu-bar icons are *template* images: black shape plus alpha, and
 * the system tints them for the light or dark bar, for the highlighted
 * state, and for whatever a future macOS decides. A coloured icon there
 * looks wrong in half of those and cannot be fixed from our side, so the
 * navy is thrown away and only the shape is kept.
 *
 * Reads packages/desktop/resources/mark-source.jpeg and writes, beside it:
 *
 *   mark.png            the mark at full size, navy on transparent
 *   trayTemplate.png    black on transparent, 18 tall, for the menu bar
 *   trayTemplate@2x.png the retina half of the same, 36 tall
 *
 * The "Template" in those names is not decoration: Electron and AppKit
 * both read it as "tint me".
 *
 * No image library: macOS `sips` handles the JPEG and the scaling, and
 * the keying in between is done here on raw pixels, with zlib from Node's
 * own standard library doing the PNG compression.
 *
 *   node scripts/make-tray-icon.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const RESOURCES = path.join(process.cwd(), "packages", "desktop", "resources");
const SOURCE = path.join(RESOURCES, "mark-source.jpeg");

/**
 * Where a pixel stops counting as background and starts counting as mark.
 * Between the two the alpha ramps, which is what keeps the curved edges
 * from turning into stairs at 18 pixels.
 */
const BACKGROUND = 245;
const SOLID = 90;

/** How tall the menu-bar icon is. Apple's ceiling is 22; width is free. */
const HEIGHT = 18;

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA pixels out as an 8-bit PNG; one filter byte per row, no filtering. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The subset of PNG that `sips` emits: 8-bit, not interlaced, RGB or RGBA. */
function decodePng(buf) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`expected an 8-bit PNG, got ${data[8]} bits`);
      if (data[12] !== 0) throw new Error("expected a non-interlaced PNG");
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (!channels) throw new Error(`unsupported PNG colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  // Undo the per-row filters (PNG spec, 9.2). Each row names its own.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

/**
 * White out, shape in. The mark is dark on white, so a pixel's darkness
 * is its coverage — which keeps the anti-aliased edge instead of cutting
 * a hard one that would shimmer when scaled down.
 */
function keyOut({ width, height, channels, pixels }, paint) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * channels];
    const g = pixels[i * channels + (channels > 2 ? 1 : 0)];
    const b = pixels[i * channels + (channels > 2 ? 2 : 0)];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const coverage = Math.max(0, Math.min(1, (BACKGROUND - luminance) / (BACKGROUND - SOLID)));
    const [pr, pg, pb] = paint ?? [r, g, b];
    rgba[i * 4] = pr;
    rgba[i * 4 + 1] = pg;
    rgba[i * 4 + 2] = pb;
    rgba[i * 4 + 3] = Math.round(coverage * 255);
  }
  return { width, height, rgba };
}

/**
 * Crop to the artwork.
 *
 * The source is a mark floating in a wide white margin. Scaled whole, the
 * shape lands on about ten of the eighteen pixels the menu bar gives it,
 * and the detail inside it has nowhere to go. Trimming the margin first
 * spends every pixel on the mark.
 */
function trim({ width, height, rgba }, edge = 10) {
  let top = height, left = width, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= edge) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return { width, height, rgba };
  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    rgba.copy(out, y * w * 4, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4);
  }
  return { width: w, height: h, rgba: out };
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "tray-icon-"));
try {
  const asPng = path.join(scratch, "source.png");
  execFileSync("sips", ["-s", "format", "png", SOURCE, "--out", asPng], { stdio: "pipe" });
  const source = decodePng(readFileSync(asPng));

  const write = (name, { width, height, rgba }) => {
    const file = path.join(RESOURCES, name);
    writeFileSync(file, encodePng(width, height, rgba));
    return file;
  };

  // The mark itself, colour intact and untrimmed, for anywhere that is
  // not the menu bar and has room for the margin.
  write("mark.png", keyOut(source, null));

  // The menu bar's two, black so macOS can tint them, and cropped to the
  // artwork so all eighteen pixels are the mark. Written at full size and
  // scaled by sips, which resamples better than anything worth writing
  // here and keeps the alpha.
  //
  // Scaled to a height, not to a box. The menu bar constrains how tall an
  // item may be and lets it be as wide as it likes, so fitting the longest
  // side would throw away half the resolution of a mark this wide for no
  // reason. At HEIGHT it comes out around 32 across, which is where the
  // board and its channel start being legible.
  const template = write("trayTemplate@2x.png", trim(keyOut(source, [0, 0, 0])));
  execFileSync("cp", [template, path.join(RESOURCES, "trayTemplate.png")]);
  execFileSync("sips", ["--resampleHeight", String(HEIGHT * 2), template], { stdio: "pipe" });
  execFileSync("sips", ["--resampleHeight", String(HEIGHT), path.join(RESOURCES, "trayTemplate.png")], { stdio: "pipe" });

  for (const name of ["mark.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
    const file = path.join(RESOURCES, name);
    const size = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" })
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(": ")[1])
      .join("x");
    console.log(`  ${name.padEnd(20)} ${size}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
