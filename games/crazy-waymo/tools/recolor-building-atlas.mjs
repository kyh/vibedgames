#!/usr/bin/env node
// Repaint the roof/wall swatches of the building kits' colormap atlases.
//
// WHY THIS EXISTS
// Every building GLB is one mesh with one material sampling one palette-stripe
// atlas; roof and wall differ only by which stripe the UVs point at. Four
// atlases serve all 57 building models. The Kenney "suburban" atlas paints its
// roof stripe GREEN, and 19 of the 21 sub-building models take 54-89% of their
// roof area from that one stripe — so three quarters of the city wore the same
// green roof. The runtime district tint (city.ts -> BatchedMesh.setColorAt)
// MULTIPLIES the atlas, so no palette entry can re-hue a green texel: green x
// pastel is still green. The fix has to happen in the texture.
//
// WHAT IT DOES
// The atlases are an 8x4 grid of 64x128 cells, each a flat base tone beside
// its 32px vertical gradient. For every listed cell this walks the cell's own
// luminance ramp and re-maps it onto a target dark->light ramp, so the
// gradient, its direction and the flat tone's relation to it all survive —
// only hue and value change. Cells that are not listed are left untouched,
// which keeps windows, doors, awnings and trim exactly as they were.
//
// Variety has to come from the atlas, because the tint is a multiply: one
// recoloured atlas would just swap a green monoculture for a grey one. So the
// kits are split into a small number of VARIANTS (see VARIANTS/ASSIGNMENT) and
// each model is pinned to one, giving a residential block a mixed roofline.
// Models sharing a variant get a byte-identical atlas, so ModelCache's material
// dedup still collapses them into one batch.
//
// Props, parks, trees and cars share these same four atlases but are NOT
// touched — public/models/props/tree-*.glb wants that green stripe.
//
// IDEMPOTENCE
// Each rewritten PNG carries a `vgRecolor` tEXt stamp naming the recipe
// version, the variant and the source atlas. A re-run recognises its own work
// and leaves the file byte-identical. If the recipe version moves on, the tool
// refuses rather than recolouring an already-recoloured atlas — restore the
// originals (`git checkout -- public/models/buildings`) and run again.
//
// PAYLOAD
// The recoloured PNG is spliced straight into the GLB's BIN chunk; everything
// behind it slides by a 4-byte-aligned delta and the buffer-0 offsets (plain
// AND meshopt) are re-based to match, so no space is wasted either way. Every
// rewrite is proved by re-parsing the result and comparing the mesh before the
// file is overwritten.
//
// Usage:  pnpm recolor:atlas [--dry-run]

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDINGS = path.join(ROOT, "public/models/buildings");

/** Bump when any ramp below changes. Stamped into every rewritten atlas. */
const RECIPE_VERSION = 1;

const GRID_COLS = 8;
const GRID_ROWS = 4;

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

// A ramp is [darkest, lightest] as 24-bit hex; the cell's own luminance range
// is stretched across it, so `dark` lands on the bottom of the gradient.

/** Shared across every recoloured 512px atlas — kills the atlas's blue cast. */
const WARM_WHITE = [0xd9d5ce, 0xffffff];
/** The kits' SECOND green stripe (r3c1), which shows up as wall/base trim. */
const LIGHT_STONE = [0x7e786c, 0xc6bfb1];

/**
 * Cell ids are `r<row>c<col>` on the 8x4 swatch grid. The ones that matter:
 *   r1c0  suburban roof stripe (the green monoculture) / minor awnings elsewhere
 *   r2c0  mid grey-blue — roof secondary everywhere, wall trim on sub/com/ind
 *   r2c1  dark slate — the dominant com/ind roof stripe
 *   r2c3  white — the dominant wall stripe
 *   r3c1  the kits' second green stripe, used as wall/base trim
 */
const VARIANTS = {
  // -- Suburban kit (21 models, ~75% of every building placed) ---------------
  // SF residential roofing: mostly dark tar-and-gravel or composition on a
  // low slope, some pale ballast gravel, slate on the older stock, and a clay
  // minority in the Mission/Marina.
  "sub-tar": {
    r1c0: [0x37332e, 0x6b635a], // tar & gravel, warm dark grey-brown
    r2c0: [0x5a544b, 0x8e877b],
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },
  "sub-slate": {
    r1c0: [0x2f3740, 0x5e6b78], // blue-grey slate
    r2c0: [0x4e5763, 0x838e9b],
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },
  "sub-gravel": {
    r1c0: [0x57534a, 0x97917f], // pale ballast gravel on a flat roof
    r2c0: [0x6a655b, 0xa09a8c],
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },
  "sub-terracotta": {
    r1c0: [0x6b3a2c, 0xb06b4e], // weathered clay tile
    r2c0: [0x6e5c50, 0xa2907f],
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },

  // -- Commercial kit (14 com + 5 skyscraper share one atlas) ----------------
  // Downtown reads as mechanical-penthouse grey and gravel, never green.
  "com-tar": {
    r1c0: [0x33352f, 0x63655a],
    r2c0: [0x55585c, 0x8b8e93], // concrete / mechanical penthouse
    r2c1: [0x2e3033, 0x55585d], // dark tar
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },
  "com-gravel": {
    r1c0: [0x4a4740, 0x7e7a6d],
    r2c0: [0x66625a, 0x9c968a],
    r2c1: [0x3b382f, 0x666253], // warm gravel ballast
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },

  // -- Industrial kit (9 models) ---------------------------------------------
  // One variant is enough: ind-a..f roof mostly from r2c1, ind-g/h/s from
  // r2c0, so splitting those two stripes already gives two rooflines.
  "ind-works": {
    r1c0: [0x3a3c36, 0x6a6c62],
    r2c0: [0x5c5f5c, 0x8f918b], // weathered galvanised
    r2c1: [0x33322e, 0x5b5951], // tar / gravel
    r2c3: WARM_WHITE,
    r3c1: LIGHT_STONE,
  },
};

/**
 * Which variant each model wears. Spread deliberately: the city picks models
 * at random per lot, so an even spread across the pool is what makes a block
 * read as a mixed row rather than a repainted monoculture.
 */
const ASSIGNMENT = {
  "sub-building-type-a": "sub-tar",
  "sub-building-type-b": "sub-slate",
  "sub-building-type-c": "sub-gravel",
  "sub-building-type-d": "sub-terracotta",
  "sub-building-type-e": "sub-tar",
  "sub-building-type-f": "sub-slate",
  "sub-building-type-g": "sub-gravel",
  "sub-building-type-h": "sub-tar",
  "sub-building-type-i": "sub-slate",
  "sub-building-type-j": "sub-terracotta",
  "sub-building-type-k": "sub-tar",
  "sub-building-type-l": "sub-gravel",
  "sub-building-type-m": "sub-slate",
  "sub-building-type-n": "sub-tar",
  "sub-building-type-o": "sub-terracotta",
  "sub-building-type-p": "sub-slate",
  "sub-building-type-q": "sub-tar",
  "sub-building-type-r": "sub-gravel",
  "sub-building-type-s": "sub-slate",
  "sub-building-type-t": "sub-terracotta",
  "sub-building-type-u": "sub-tar",

  "com-building-a": "com-tar",
  "com-building-b": "com-gravel",
  "com-building-c": "com-tar",
  "com-building-d": "com-gravel",
  "com-building-e": "com-tar",
  "com-building-f": "com-gravel",
  "com-building-g": "com-tar",
  "com-building-h": "com-gravel",
  "com-building-i": "com-tar",
  "com-building-j": "com-gravel",
  "com-building-k": "com-tar",
  "com-building-l": "com-gravel",
  "com-building-m": "com-tar",
  "com-building-n": "com-gravel",
  "com-building-skyscraper-a": "com-tar",
  "com-building-skyscraper-b": "com-gravel",
  "com-building-skyscraper-c": "com-tar",
  "com-building-skyscraper-d": "com-gravel",
  "com-building-skyscraper-e": "com-tar",

  "ind-building-a": "ind-works",
  "ind-building-b": "ind-works",
  "ind-building-c": "ind-works",
  "ind-building-d": "ind-works",
  "ind-building-e": "ind-works",
  "ind-building-f": "ind-works",
  "ind-building-g": "ind-works",
  "ind-building-h": "ind-works",
  "ind-building-s": "ind-works",
};

/**
 * Models left alone, with the reason. The kk (citybits) kit already roofs in
 * grey-silver, its atlas is 1024px (4x the VRAM of a variant on the 512s), and
 * it is shared with 40 park/prop/car models — a variant would cost more than
 * the monoculture it fixes.
 */
const SKIP = {
  "kk-building-a": "citybits kit — roofs already grey, 1024px atlas shared with parks/props",
  "kk-building-b": "citybits kit",
  "kk-building-c": "citybits kit",
  "kk-building-d": "citybits kit",
  "kk-building-e": "citybits kit",
  "kk-building-f": "citybits kit",
  "kk-building-g": "citybits kit",
  "kk-building-h": "citybits kit",
};

// ---------------------------------------------------------------------------
// PNG (8-bit, non-interlaced) — decode to RGBA, re-encode as indexed or RGBA
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  const out = [];
  let off = PNG_SIGNATURE.length;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    out.push({
      type: buf.toString("ascii", off + 4, off + 8),
      data: buf.subarray(off + 8, off + 8 + len),
    });
    off += 12 + len;
  }
  return out;
}

function writeChunks(chunks) {
  const parts = [PNG_SIGNATURE];
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(c.data.length, 0);
    const type = Buffer.from(c.type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, c.data])), 0);
    parts.push(len, type, c.data, crc);
  }
  return Buffer.concat(parts);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode to a flat RGBA Uint8Array plus the chunks we may want to carry over. */
function decodeRgba(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("PNG has no IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`unsupported color type ${colorType}`);

  const idat = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  );
  const stride = width * ch;
  const raw = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = idat[p++];
    const line = idat.subarray(p, p + stride);
    p += stride;
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      const v = line[x];
      cur[x] =
        filter === 0
          ? v
          : filter === 1
            ? (v + a) & 255
            : filter === 2
              ? (v + b) & 255
              : filter === 3
                ? (v + ((a + b) >> 1)) & 255
                : (v + paeth(a, b, c)) & 255;
    }
  }

  const plte = chunks.find((c) => c.type === "PLTE")?.data;
  const trns = chunks.find((c) => c.type === "tRNS")?.data;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * ch;
    const d = i * 4;
    if (colorType === 3) {
      const idx = raw[s];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 6) {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s + 1];
      rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = raw[s + 3];
    } else if (colorType === 2) {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s + 1];
      rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = 255;
    } else {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s];
      rgba[d + 2] = raw[s];
      rgba[d + 3] = colorType === 4 ? raw[s + 1] : 255;
    }
  }
  const stamp = chunks.find(
    (c) =>
      c.type === "tEXt" &&
      c.data.indexOf(0) === STAMP_KEY.length &&
      c.data.subarray(0, STAMP_KEY.length).toString("latin1") === STAMP_KEY,
  );
  return {
    width,
    height,
    colorType,
    rgba,
    // Indexed sources keep their raster and palette: re-encoding through the
    // ORIGINAL index order is what keeps the IDAT as small as the one we are
    // replacing (a scan-order rebuild costs ~3KB on the suburban atlas).
    indices: colorType === 3 ? raw : null,
    palette: plte ? Buffer.from(plte) : null,
    paletteAlpha: trns ? Buffer.from(trns) : null,
    stamp: stamp
      ? stamp.data
          .subarray(STAMP_KEY.length + 1)
          .toString("latin1")
          .trimEnd()
      : null,
  };
}

/** Per-row adaptive filtering: try all five, keep the cheapest by the standard
 *  minimum-sum-of-absolute-differences heuristic, then brute-force the deflate
 *  strategy. These atlases are tiny, and every byte saved keeps the recoloured
 *  PNG inside the byte budget of the one it replaces. */
function filterAndDeflate(pixels, width, height, ch) {
  const stride = width * ch;
  const out = Buffer.alloc(height * (stride + 1));
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0;
    let bestScore = Infinity;
    let best = null;
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= ch ? prev[x - ch] : 0;
        const v = cur[x];
        const d =
          f === 0
            ? v
            : f === 1
              ? (v - a) & 255
              : f === 2
                ? (v - b) & 255
                : f === 3
                  ? (v - ((a + b) >> 1)) & 255
                  : (v - paeth(a, b, c)) & 255;
        cand[x] = d;
        score += d < 128 ? d : 256 - d;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = f;
        best = Buffer.from(cand);
      }
    }
    out[y * (stride + 1)] = bestType;
    best.copy(out, y * (stride + 1) + 1);
  }
  let smallest = null;
  for (const strategy of [0, 1, 2, 3, 4]) {
    const z = deflateSync(out, { level: 9, memLevel: 9, strategy });
    if (!smallest || z.length < smallest.length) smallest = z;
  }
  return smallest;
}

const PALETTE_SLOTS = 256;

/**
 * Re-index a recoloured indexed image, reusing the ORIGINAL slot numbering
 * wherever it still makes sense. Each new colour is pulled towards the source
 * slot it most often replaced, and slots freed by a recolour are handed to the
 * colours that need them; that keeps index runs where they were, which is what
 * keeps the IDAT as small as the one being replaced. Null when the recoloured
 * image needs more than 256 colours — the caller then coarsens the ramps.
 */
function reindex(img) {
  const { indices, rgba } = img;
  const n = indices.length;

  // Distinct new colours, and how often each came through each source slot.
  const votes = new Map(); // packed colour -> Map(source slot -> count)
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const packed = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    let tally = votes.get(packed);
    if (!tally) {
      if (votes.size === PALETTE_SLOTS) return null;
      tally = new Map();
      votes.set(packed, tally);
    }
    tally.set(indices[i], (tally.get(indices[i]) ?? 0) + 1);
  }

  const slotOf = new Map(); // packed colour -> final slot
  const taken = new Uint8Array(PALETTE_SLOTS);
  const homeless = [];
  for (const [packed, tally] of votes) {
    let best = -1;
    let bestCount = -1;
    for (const [slot, count] of tally) {
      if (count > bestCount) {
        bestCount = count;
        best = slot;
      }
    }
    if (best >= 0 && !taken[best]) {
      taken[best] = 1;
      slotOf.set(packed, best);
    } else {
      homeless.push(packed);
    }
  }
  let next = 0;
  for (const packed of homeless) {
    while (taken[next]) next++;
    taken[next] = 1;
    slotOf.set(packed, next);
  }

  const size = Math.max(...slotOf.values()) + 1;
  const palette = Buffer.alloc(size * 3);
  const alpha = Buffer.alloc(size, 255);
  let lastTranslucent = -1;
  for (const [packed, slot] of slotOf) {
    palette[slot * 3] = (packed >>> 24) & 255;
    palette[slot * 3 + 1] = (packed >>> 16) & 255;
    palette[slot * 3 + 2] = (packed >>> 8) & 255;
    alpha[slot] = packed & 255;
    if (alpha[slot] !== 255) lastTranslucent = Math.max(lastTranslucent, slot);
  }

  const pixels = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    pixels[i] = slotOf.get(
      ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0,
    );
  }
  return {
    pixels,
    palette,
    alpha: lastTranslucent >= 0 ? alpha.subarray(0, lastTranslucent + 1) : null,
  };
}

/** Re-encode RGBA. Keeps an indexed source indexed when the colours still fit
 *  in 256 entries (that is what makes the suburban atlas so small). */
function encodeRgba(img, extraChunks) {
  const { width, height, rgba } = img;
  let pixels;
  let colorType;
  let palette = null;
  let trns = null;

  const indexed = img.indices ? reindex(img) : null;
  if (indexed) {
    colorType = 3;
    pixels = indexed.pixels;
    palette = indexed.palette;
    trns = indexed.alpha;
  } else {
    colorType = 6;
    pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  }

  const ch = CHANNELS[colorType];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const chunks = [{ type: "IHDR", data: ihdr }];
  if (palette) chunks.push({ type: "PLTE", data: palette });
  if (trns) chunks.push({ type: "tRNS", data: trns });
  chunks.push({ type: "IDAT", data: filterAndDeflate(pixels, width, height, ch) });
  chunks.push(...extraChunks, { type: "IEND", data: Buffer.alloc(0) });
  return writeChunks(chunks);
}

const STAMP_KEY = "vgRecolor";

/** tEXt chunk carrying the idempotence stamp, optionally right-padded so the
 *  whole PNG lands on a chosen byte length. */
function stampChunk(text, padding) {
  return {
    type: "tEXt",
    data: Buffer.from(`${STAMP_KEY}\0${text}${" ".repeat(padding)}`, "latin1"),
  };
}

// ---------------------------------------------------------------------------
// Recolouring
// ---------------------------------------------------------------------------

const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function parseCellId(id) {
  const m = /^r(\d)c(\d)$/.exec(id);
  if (!m) throw new Error(`bad cell id "${id}"`);
  return { row: Number(m[1]), col: Number(m[2]) };
}

/**
 * Every colormap cell is a PAIR of 32px swatches: a flat base tone beside its
 * vertical gradient. Building UVs only ever land on the gradient half, but the
 * flat half has to move with it or mip-blending across the seam reintroduces
 * the old hue.
 */
const SWATCH_HALVES = 2;

/**
 * More than this much luminance spread inside one row of one half means the
 * swatch is not the flat-or-gradient pair this repaint assumes. Some spread is
 * expected — the suburban atlas is indexed and its gradients carry
 * error-diffusion dither — but painted detail would blow straight past it.
 */
const MAX_ROW_SPREAD = 0.12;

/**
 * Stretch one cell's own vertical luminance ramp across `[dark, light]`, in
 * place. Position in the ramp is preserved, so the gradient, its direction and
 * the flat half's relation to it all survive; only hue and value move. The
 * range is taken across the whole cell, which is what puts the flat base tone
 * at the light end where the source art has it.
 *
 * Each half-row is written from its MEAN luminance: the horizontal wobble in
 * these swatches is palette-quantisation dither, not art, and dropping it is
 * both truer to the source and far cheaper to deflate.
 *
 * `steps` (0 = off) quantises the ramp. An indexed atlas only has 256 palette
 * entries to spend and recoloured cells can ask for more shades than they
 * free, so `recolour` walks this down until the palette fits. The swatches are
 * ~19-step gradients sampled with NEAREST across whole roof planes, so a dozen
 * steps is indistinguishable in play.
 */
function repaintCell(img, cellId, ramp, steps) {
  const { row, col } = parseCellId(cellId);
  const cw = img.width / GRID_COLS;
  const chh = img.height / GRID_ROWS;
  const half = cw / SWATCH_HALVES;
  const x0 = col * cw;
  const y0 = row * chh;

  // Mean luminance of every half-row, and the cell's overall range.
  const means = new Float64Array(chh * SWATCH_HALVES);
  let lo = Infinity;
  let hi = -Infinity;
  for (let r = 0; r < chh; r++) {
    for (let h = 0; h < SWATCH_HALVES; h++) {
      let sum = 0;
      let rowLo = Infinity;
      let rowHi = -Infinity;
      for (let x = x0 + h * half; x < x0 + (h + 1) * half; x++) {
        const d = ((y0 + r) * img.width + x) * 4;
        const l = luminance(img.rgba[d], img.rgba[d + 1], img.rgba[d + 2]);
        sum += l;
        if (l < rowLo) rowLo = l;
        if (l > rowHi) rowHi = l;
      }
      if (rowHi - rowLo > MAX_ROW_SPREAD) {
        throw new Error(
          `cell ${cellId} row ${r} half ${h} is not flat or a gradient (spread ${(rowHi - rowLo).toFixed(3)})`,
        );
      }
      const mean = sum / half;
      means[r * SWATCH_HALVES + h] = mean;
      if (mean < lo) lo = mean;
      if (mean > hi) hi = mean;
    }
  }

  const span = hi - lo;
  const [dark, light] = ramp;
  const dr = (dark >> 16) & 255;
  const dg = (dark >> 8) & 255;
  const db = dark & 255;
  const lr = (light >> 16) & 255;
  const lg = (light >> 8) & 255;
  const lb = light & 255;
  for (let r = 0; r < chh; r++) {
    for (let h = 0; h < SWATCH_HALVES; h++) {
      const raw = span > 1e-6 ? (means[r * SWATCH_HALVES + h] - lo) / span : 1;
      const t = steps > 0 ? Math.round(raw * (steps - 1)) / (steps - 1) : raw;
      const cr = Math.round(dr + (lr - dr) * t);
      const cg = Math.round(dg + (lg - dg) * t);
      const cb = Math.round(db + (lb - db) * t);
      for (let x = x0 + h * half; x < x0 + (h + 1) * half; x++) {
        const d = ((y0 + r) * img.width + x) * 4;
        img.rgba[d] = cr;
        img.rgba[d + 1] = cg;
        img.rgba[d + 2] = cb;
      }
    }
  }
}

/** Ramp step counts to try, finest first. */
const RAMP_STEPS = [0, 24, 20, 16, 14, 12, 10, 8];

/**
 * Apply a variant to a copy of `img`. An indexed source gets the finest ramp
 * that still re-indexes inside 256 palette entries — staying indexed is what
 * keeps the suburban atlas small.
 */
function recolour(img, variant) {
  const cells = Object.entries(variant);
  for (const steps of RAMP_STEPS) {
    const out = { ...img, rgba: Uint8Array.from(img.rgba) };
    for (const [cellId, ramp] of cells) repaintCell(out, cellId, ramp, steps);
    if (!out.indices || reindex(out)) return { image: out, steps };
  }
  throw new Error("no ramp quantisation fits 256 palette entries");
}

// ---------------------------------------------------------------------------
// GLB container: read the embedded image, splice a same-length one back in
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB");
  const total = Math.min(dv.getUint32(8, true), buf.length);
  let off = 12;
  let json = null;
  let binStart = -1;
  let binLength = 0;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (type === CHUNK_JSON)
      json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
    else if (type === CHUNK_BIN) {
      binStart = off + 8;
      binLength = len;
    }
    off += 8 + len;
  }
  if (!json || binStart < 0) throw new Error("GLB is missing a JSON or BIN chunk");
  return { json, binStart, binLength };
}

/** Byte range of image 0 inside the whole GLB file. */
function imageRange(glb) {
  const image = glb.json.images?.[0];
  if (!image || image.bufferView === undefined)
    throw new Error("GLB has no bufferView-backed image");
  const bv = glb.json.bufferViews[image.bufferView];
  if (bv.buffer !== 0) throw new Error("image lives outside the BIN chunk");
  return { view: image.bufferView, offset: bv.byteOffset ?? 0, length: bv.byteLength };
}

/** How much the image's bufferView has to move to hold `pngLength`, as a
 *  multiple of 4 (negative shrinks). Keeping the shift 4-aligned preserves the
 *  alignment glTF requires of every accessor and meshopt stream behind it. */
function imageShift(range, pngLength) {
  return Math.ceil((pngLength - range.length) / 4) * 4;
}

/**
 * Splice a recoloured image into the BIN chunk. Everything after the image
 * slides by `shift` and every buffer-0 offset past it is re-based by the same
 * amount — both the plain `bufferView.byteOffset` and the
 * EXT_meshopt_compression offsets, which address buffer 0 directly.
 */
function spliceImage(buf, glb, range, png) {
  const shift = imageShift(range, png.length);
  const newLength = range.length + shift;
  if (png.length !== newLength) throw new Error("image was not padded to its slot");

  const json = glb.json;
  json.bufferViews[range.view].byteLength = newLength;
  const rebase = (holder, key) => {
    const at = holder[key] ?? 0;
    if (at > range.offset) holder[key] = at + shift;
  };
  for (const bv of json.bufferViews) {
    if (bv.buffer === 0) rebase(bv, "byteOffset");
    const meshopt = bv.extensions?.EXT_meshopt_compression;
    if (meshopt && meshopt.buffer === 0) rebase(meshopt, "byteOffset");
  }
  json.buffers[0].byteLength += shift;

  const bin = Buffer.alloc(glb.binLength + shift);
  buf.copy(bin, 0, glb.binStart, glb.binStart + range.offset);
  png.copy(bin, range.offset);
  buf.copy(
    bin,
    range.offset + newLength,
    glb.binStart + range.offset + range.length,
    glb.binStart + glb.binLength,
  );

  let text = Buffer.from(JSON.stringify(json), "utf8");
  while (text.length % 4 !== 0) text = Buffer.concat([text, Buffer.from(" ")]);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(text.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  return Buffer.concat([head, jsonHeader, text, binHeader, bin]);
}

// ---------------------------------------------------------------------------
// Reporting: area-weighted dominant roof / wall colour, straight off the mesh
// ---------------------------------------------------------------------------

/** GLTFLoader in Node cannot decode an embedded texture (no createImageBitmap
 *  and no document), and we only want positions/normals/UVs — so hand it a
 *  copy with the image references removed. BIN offsets are untouched. */
function withoutImages(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const total = Math.min(dv.getUint32(8, true), buf.length);
  let off = 12;
  const chunks = [];
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    chunks.push({ type: dv.getUint32(off + 4, true), data: buf.subarray(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON);
  const json = JSON.parse(new TextDecoder().decode(jsonChunk.data));
  for (const mat of json.materials ?? []) {
    delete mat.normalTexture;
    delete mat.occlusionTexture;
    delete mat.emissiveTexture;
    if (mat.pbrMetallicRoughness) {
      delete mat.pbrMetallicRoughness.baseColorTexture;
      delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  delete json.textures;
  delete json.images;
  delete json.samplers;
  json.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => e !== "KHR_texture_transform");
  let text = Buffer.from(JSON.stringify(json), "utf8");
  while (text.length % 4 !== 0) text = Buffer.concat([text, Buffer.from(" ")]);
  const parts = [];
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(text.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  parts.push(jsonHeader, text);
  for (const c of chunks) {
    if (c.type === CHUNK_JSON) continue;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(c.data.length, 0);
    header.writeUInt32LE(c.type, 4);
    parts.push(header, Buffer.from(c.data));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

function parseGeometry(buf) {
  const stripped = withoutImages(buf);
  const ab = stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength);
  return new Promise((resolve, reject) => gltfLoader.parse(ab, "", resolve, reject));
}

/**
 * Every triangle's surface area and UV centroid, tagged roof (normal points
 * up) or wall. Roof/wall is a geometric fact, not a guess about the atlas.
 */
async function sampleFaces(buf) {
  const gltf = await parseGeometry(buf);
  gltf.scene.updateWorldMatrix(true, true);
  const faces = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  gltf.scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geo = node.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!pos || !uv) return;
    const index = geo.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(node.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(node.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(node.matrixWorld);
      cross.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const len = cross.length();
      if (len <= 0) continue;
      const ny = cross.y / len;
      // Downward faces are undersides (eaves, overhangs) — neither roof nor wall.
      const kind = ny > 0.65 ? "roof" : ny < -0.5 ? null : "wall";
      if (!kind) continue;
      faces.push({
        kind,
        area: len * 0.5,
        u: (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3,
        v: (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3,
      });
    }
  });
  return faces;
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const hex = (r, g, b) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** The single colour that covers the most roof (or wall) area, and its share. */
function dominant(faces, kind, img) {
  const byColor = new Map();
  let total = 0;
  for (const f of faces) {
    if (f.kind !== kind) continue;
    // glTF UV origin is the image's top-left corner — no v flip.
    const x = Math.min(img.width - 1, Math.max(0, Math.floor(f.u * img.width)));
    const y = Math.min(img.height - 1, Math.max(0, Math.floor(f.v * img.height)));
    const d = (y * img.width + x) * 4;
    const key = hex(img.rgba[d], img.rgba[d + 1], img.rgba[d + 2]);
    byColor.set(key, (byColor.get(key) ?? 0) + f.area);
    total += f.area;
  }
  if (total === 0) return { color: "—", share: 0 };
  let best = "—";
  let bestArea = 0;
  for (const [color, area] of byColor) {
    if (area > bestArea) {
      bestArea = area;
      best = color;
    }
  }
  return { color: best, share: bestArea / total };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const files = readdirSync(BUILDINGS)
    .filter((f) => f.endsWith(".glb"))
    .toSorted();

  const unassigned = files
    .map((f) => path.basename(f, ".glb"))
    .filter((n) => !ASSIGNMENT[n] && !SKIP[n]);
  if (unassigned.length > 0) {
    throw new Error(
      `no variant assigned to: ${unassigned.join(", ")} — add them to ASSIGNMENT or SKIP`,
    );
  }

  console.log(`recolor-building-atlas v${RECIPE_VERSION}${dryRun ? " (dry run)" : ""}`);
  console.log(
    `${files.length} models, ${Object.keys(VARIANTS).length} variants, ${Object.keys(SKIP).length} skipped\n`,
  );

  const rows = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  let written = 0;
  let unchanged = 0;
  const atlasBytes = new Map();

  for (const file of files) {
    const name = path.basename(file, ".glb");
    const full = path.join(BUILDINGS, file);
    const glbBefore = readFileSync(full);
    bytesBefore += glbBefore.length;

    if (SKIP[name]) {
      bytesAfter += glbBefore.length;
      rows.push({ name, variant: "—", note: "skipped" });
      continue;
    }

    const variantId = ASSIGNMENT[name];
    const variant = VARIANTS[variantId];
    if (!variant) throw new Error(`${name} is assigned unknown variant "${variantId}"`);

    const glb = readGlb(glbBefore);
    const range = imageRange(glb);
    const pngStart = glb.binStart + range.offset;
    const pngBefore = glbBefore.subarray(pngStart, pngStart + range.length);
    const sourceHash = createHash("md5").update(pngBefore).digest("hex").slice(0, 8);
    const before = decodeRgba(pngBefore);

    const faces = await sampleFaces(glbBefore);
    const roofBefore = dominant(faces, "roof", before);
    const wallBefore = dominant(faces, "wall", before);

    if (before.stamp !== null) {
      // Already recoloured. The originals are gone from this file, so the only
      // honest options are "leave it" or "make the operator restore them".
      const [stampedVersion, stampedVariant] = before.stamp.split(" ");
      if (Number(stampedVersion) !== RECIPE_VERSION || stampedVariant !== variantId) {
        throw new Error(
          `${file} carries recipe v${stampedVersion}/${stampedVariant} but this run wants v${RECIPE_VERSION}/${variantId}. ` +
            `Restore the shipped atlases first: git checkout -- public/models/buildings`,
        );
      }
      bytesAfter += glbBefore.length;
      unchanged++;
      rows.push({
        name,
        variant: variantId,
        roofBefore,
        wallBefore,
        roofAfter: roofBefore,
        wallAfter: wallBefore,
        note: "already current",
      });
      continue;
    }

    const { image: after, steps } = recolour(before, variant);

    const stampText = `${RECIPE_VERSION} ${variantId} ${sourceHash}`;
    const bare = encodeRgba(after, [stampChunk(stampText, 0)]);
    // Round the image's slot to a 4-byte boundary and pad the stamp out to it,
    // so the BIN chunk never carries slack the bufferView does not describe.
    const slot = range.length + imageShift(range, bare.length);
    const pngAfter = encodeRgba(after, [stampChunk(stampText, slot - bare.length)]);
    if (pngAfter.length !== slot)
      throw new Error(`${file}: padded atlas is ${pngAfter.length}B, expected ${slot}B`);
    atlasBytes.set(variantId, { bytes: pngAfter.length, was: range.length, steps });

    const roofAfter = dominant(faces, "roof", after);
    const wallAfter = dominant(faces, "wall", after);
    rows.push({ name, variant: variantId, roofBefore, wallBefore, roofAfter, wallAfter, note: "" });

    if (dryRun) {
      bytesAfter += glbBefore.length + imageShift(range, bare.length);
      continue;
    }
    const out = spliceImage(glbBefore, glb, range, pngAfter);
    // The BIN chunk just moved under every accessor in the file. Prove the mesh
    // still reads back before overwriting a shipped asset.
    const reparsed = await sampleFaces(out);
    if (reparsed.length !== faces.length) {
      throw new Error(
        `${file}: rewrite changed the mesh (${faces.length} -> ${reparsed.length} faces)`,
      );
    }
    writeFileSync(full, out);
    bytesAfter += out.length;
    written++;
  }

  console.log(
    `${"model".padEnd(30)}${"variant".padEnd(16)}${"roof before".padEnd(20)}${"roof after".padEnd(20)}${"wall before".padEnd(20)}wall after`,
  );
  for (const r of rows) {
    if (!r.roofBefore) {
      console.log(`${r.name.padEnd(30)}${r.variant.padEnd(16)}${r.note}`);
      continue;
    }
    const cell = (d) => `${d.color} ${pct(d.share)}`.padEnd(20);
    console.log(
      `${r.name.padEnd(30)}${r.variant.padEnd(16)}${cell(r.roofBefore)}${cell(r.roofAfter)}${cell(r.wallBefore)}${cell(r.wallAfter)}${r.note ? `  (${r.note})` : ""}`,
    );
  }

  const roofSpread = new Map();
  for (const r of rows)
    if (r.roofAfter)
      roofSpread.set(r.roofAfter.color, (roofSpread.get(r.roofAfter.color) ?? 0) + 1);
  console.log(
    `\ndominant roof colours after: ${[...roofSpread].map(([c, n]) => `${c} x${n}`).join("  ")}`,
  );
  console.log(
    `distinct atlases now embedded in building GLBs: ${Object.keys(VARIANTS).length} recoloured + 1 untouched (citybits)`,
  );
  console.log(
    `written: ${written}   already current: ${unchanged}   skipped: ${Object.keys(SKIP).length}`,
  );
  for (const [id, a] of atlasBytes)
    console.log(
      `atlas ${id.padEnd(16)} ${a.was}B -> ${a.bytes}B  ramp steps: ${a.steps === 0 ? "full" : a.steps}`,
    );
  console.log(`payload: ${bytesBefore}B -> ${bytesAfter}B (delta ${bytesAfter - bytesBefore}B)`);
}

main().catch((err) => {
  console.error(`[recolor-building-atlas] ${err.message}`);
  process.exitCode = 1;
});
