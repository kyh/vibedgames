#!/usr/bin/env node
/**
 * check-canvas.mjs — verify a Three.js (or any WebGL/canvas) page actually renders.
 *
 * Loads a URL in headless Chromium, screenshots the canvas, and measures pixel
 * variance. A page that builds fine but renders black/blank is the #1 silent
 * Three.js failure; this catches it objectively (CI, pre-`vg deploy`, regressions).
 *
 * Usage:
 *   node check-canvas.mjs <url> [--selector <css>] [--out <png>] [--wait <ms>]
 *                               [--min-std <n>] [--json]
 *
 * Examples:
 *   node check-canvas.mjs http://localhost:5173
 *   node check-canvas.mjs ./dist/index.html --out /tmp/frame.png --json
 *
 * Exit codes:
 *   0 = canvas rendered non-blank content
 *   1 = canvas is blank / solid color (likely a render failure)
 *   2 = error (no canvas, page error, missing Playwright, bad args)
 *
 * Requires Playwright (already used by the `playwright` skill); Chromium is
 * pre-resolved via PLAYWRIGHT_BROWSERS_PATH in this environment.
 */

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function parseArgs(argv) {
  const opts = { selector: "canvas", out: null, wait: 1500, minStd: 4, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector") opts.selector = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--wait") opts.wait = Number(argv[++i]);
    else if (a === "--min-std") opts.minStd = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else rest.push(a);
  }
  opts.target = rest[0];
  return opts;
}

function toUrl(target) {
  if (/^https?:\/\//.test(target) || /^file:\/\//.test(target)) return target;
  return pathToFileURL(target).href; // local file path → file:// URL
}

/** Minimal PNG decoder: 8-bit, non-interlaced, color types 0/2/4/6. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let width = 0,
    height = 0,
    colorType = 6,
    bitDepth = 8;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`color type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let recon;
      switch (filter) {
        case 0: recon = v; break;
        case 1: recon = v + a; break;
        case 2: recon = v + b; break;
        case 3: recon = v + ((a + b) >> 1); break;
        case 4: recon = v + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      out[y * stride + x] = recon & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Luminance stddev + non-transparent fraction over a sampled grid. */
function analyze({ width, height, channels, data }) {
  const stride = width * channels;
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  let n = 0,
    sum = 0,
    sumSq = 0,
    opaque = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = y * stride + x * channels;
      let r, g, b, alpha;
      if (channels >= 3) {
        r = data[i]; g = data[i + 1]; b = data[i + 2];
        alpha = channels === 4 ? data[i + 3] : 255;
      } else {
        r = g = b = data[i];
        alpha = channels === 2 ? data[i + 1] : 255;
      }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      sumSq += lum * lum;
      if (alpha > 8) opaque++;
      n++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { sampled: n, meanLum: mean, stdLum: std, opaqueFraction: opaque / n };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.target) {
    console.error("usage: node check-canvas.mjs <url|file> [--selector css] [--out png] [--wait ms] [--min-std n] [--json]");
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright not found. Install it: pnpm add -D playwright (Chromium is pre-resolved in this environment).");
    return 2;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  try {
    await page.goto(toUrl(opts.target), { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(opts.wait); // let assets load + a few frames render

    const canvas = await page.$(opts.selector);
    if (!canvas) {
      report(opts, { ok: false, reason: `no element matching "${opts.selector}"`, consoleErrors });
      return 2;
    }
    const png = await canvas.screenshot();
    if (opts.out) writeFileSync(opts.out, png);

    const stats = analyze(decodePng(png));
    const ok = stats.stdLum >= opts.minStd && stats.opaqueFraction > 0.01;
    report(opts, {
      ok,
      reason: ok ? "rendered non-blank content" : `blank/solid (stdLum ${stats.stdLum.toFixed(2)} < ${opts.minStd})`,
      ...stats,
      out: opts.out,
      consoleErrors,
    });
    return ok ? 0 : 1;
  } catch (err) {
    report(opts, { ok: false, reason: String(err?.message || err), consoleErrors });
    return 2;
  } finally {
    await browser.close();
  }
}

function report(opts, result) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.ok ? "PASS" : "FAIL"} — ${result.reason}`);
  if (result.stdLum !== undefined) {
    console.log(`  luminance stddev: ${result.stdLum.toFixed(2)}  mean: ${result.meanLum.toFixed(1)}  opaque: ${(result.opaqueFraction * 100).toFixed(1)}%`);
  }
  if (result.out) console.log(`  screenshot: ${result.out}`);
  if (result.consoleErrors?.length) {
    console.log(`  console errors (${result.consoleErrors.length}):`);
    for (const e of result.consoleErrors.slice(0, 5)) console.log(`    - ${e}`);
  }
}

process.exit(await main());
