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
 *                               [--min-std <n>] [--mobile] [--json]
 *
 * Examples:
 *   node check-canvas.mjs http://localhost:5173
 *   node check-canvas.mjs ./dist/index.html --out /tmp/frame.png --json
 *   node check-canvas.mjs http://localhost:5173 --mobile
 *
 * --mobile emulates a phone-class device (390×844 viewport, DPR 3, touch) and
 * applies the mobile render budget tier.
 *
 * Render budget (advisory, never fails the check): if the page exposes
 * `window.__GAME_DIAGNOSTICS__.renderer` — a snapshot of renderer.info like
 * { calls, triangles, geometries, textures } (see
 * references/debugging-and-profiling.md) — over-budget metrics are reported.
 *
 * Exit codes:
 *   0 = canvas rendered non-blank content
 *   1 = render failure: blank/solid canvas, or an uncaught page exception
 *   2 = error (no canvas, navigation failure, missing Playwright, bad args)
 *
 * Requires Playwright (already used by the `playwright` skill); Chromium is
 * pre-resolved via PLAYWRIGHT_BROWSERS_PATH in this environment.
 */

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

// Starting-point render budgets (references/debugging-and-profiling.md).
// Over-budget rows are reported, never fatal.
const RENDER_BUDGETS = {
  desktop: { calls: 300, triangles: 750_000, geometries: 300, textures: 60 },
  mobile: { calls: 150, triangles: 300_000, geometries: 200, textures: 40 },
};

function parseArgs(argv) {
  const opts = { selector: "canvas", out: null, wait: 1500, minStd: 4, json: false, mobile: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector") opts.selector = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--wait") opts.wait = Number(argv[++i]);
    else if (a === "--min-std") opts.minStd = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--mobile") opts.mobile = true;
    else rest.push(a);
  }
  opts.target = rest[0];
  // reject malformed numeric flags (e.g. a missing arg → NaN) rather than
  // silently treating NaN thresholds as "passing"
  if (!Number.isFinite(opts.wait) || opts.wait < 0) {
    throw new Error(`--wait must be a non-negative number (got ${opts.wait})`);
  }
  if (!Number.isFinite(opts.minStd) || opts.minStd < 0) {
    throw new Error(`--min-std must be a non-negative number (got ${opts.minStd})`);
  }
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
  if (n === 0) return { sampled: 0, meanLum: 0, stdLum: 0, opaqueFraction: 0 };
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { sampled: n, meanLum: mean, stdLum: std, opaqueFraction: opaque / n };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err?.message || err));
    return 2;
  }
  if (!opts.target) {
    console.error("usage: node check-canvas.mjs <url|file> [--selector css] [--out png] [--wait ms] [--min-std n] [--mobile] [--json]");
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright not found. Install it: pnpm add -D playwright (Chromium is pre-resolved in this environment).");
    return 2;
  }

  // browser declared before the try so `finally` can always close it, even if
  // launch()/newPage() throws (otherwise a failure here leaks a Chromium process).
  let browser;
  const consoleErrors = []; // console.error() — advisory (benign 404s etc.)
  const pageErrors = []; // uncaught exceptions — fail the check
  try {
    browser = await chromium.launch();
    const page = await browser.newPage(
      opts.mobile
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
        : { viewport: { width: 1280, height: 720 } },
    );
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(toUrl(opts.target), { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(opts.wait); // let assets load + a few frames render

    const canvas = await page.$(opts.selector);
    if (!canvas) {
      report(opts, { ok: false, reason: `no element matching "${opts.selector}"`, consoleErrors, pageErrors });
      return 2;
    }
    const png = await canvas.screenshot();
    if (opts.out) writeFileSync(opts.out, png);

    // Advisory render-budget check: only when the page exposes a diagnostics
    // snapshot (window.__GAME_DIAGNOSTICS__.renderer = renderer.info numbers).
    const tier = opts.mobile ? "mobile" : "desktop";
    const rendererInfo = await page
      .evaluate(() => globalThis.__GAME_DIAGNOSTICS__?.renderer ?? null)
      .catch(() => null);
    const budget = rendererInfo
      ? Object.entries(RENDER_BUDGETS[tier]).map(([metric, limit]) => ({
          metric,
          actual: typeof rendererInfo[metric] === "number" ? rendererInfo[metric] : null,
          limit,
          ok: typeof rendererInfo[metric] === "number" ? rendererInfo[metric] <= limit : null,
        }))
      : null;

    const stats = analyze(decodePng(png));
    // positive comparisons negated, so a non-finite metric fails (never a false pass)
    const blankLum = !(stats.stdLum >= opts.minStd);
    const nearEmpty = !(stats.opaqueFraction > 0.01);
    // an uncaught page exception is a real render regression even if pixels drew
    const ok = !blankLum && !nearEmpty && pageErrors.length === 0;
    const reason = ok
      ? "rendered non-blank content"
      : pageErrors.length
        ? `uncaught page error: ${pageErrors[0]}`
        : nearEmpty
          ? `near-empty canvas (opaque ${(stats.opaqueFraction * 100).toFixed(1)}% ≤ 1%)`
          : `blank/solid (stdLum ${stats.stdLum.toFixed(2)} < ${opts.minStd})`;
    report(opts, { ok, reason, ...stats, tier, budget, out: opts.out, consoleErrors, pageErrors });
    return ok ? 0 : 1;
  } catch (err) {
    report(opts, { ok: false, reason: String(err?.message || err), consoleErrors, pageErrors });
    return 2;
  } finally {
    if (browser) await browser.close();
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
  if (result.budget) {
    const over = result.budget.filter((row) => row.ok === false);
    if (over.length) {
      console.log(`  render budget (${result.tier} tier, advisory) — OVER:`);
      for (const row of over) console.log(`    - ${row.metric}: ${row.actual} > ${row.limit}`);
    } else {
      console.log(`  render budget (${result.tier} tier): within limits`);
    }
  }
  if (result.pageErrors?.length) {
    console.log(`  uncaught page errors (${result.pageErrors.length}):`);
    for (const e of result.pageErrors.slice(0, 5)) console.log(`    - ${e}`);
  }
  if (result.consoleErrors?.length) {
    console.log(`  console errors (${result.consoleErrors.length}, advisory):`);
    for (const e of result.consoleErrors.slice(0, 5)) console.log(`    - ${e}`);
  }
}

process.exit(await main());
