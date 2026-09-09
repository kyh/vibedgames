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

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

/** Print this file's header docblock, so `--help` cannot drift from the docs. */
const printHelp = () => {
  const source = readFileSync(import.meta.filename, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);
  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();
  process.stdout.write(`${text || "No help available."}\n`);
};

// Starting-point render budgets (references/debugging-and-profiling.md).
// Over-budget rows are reported, never fatal.
const RENDER_BUDGETS = {
  desktop: { calls: 300, geometries: 300, textures: 60, triangles: 750_000 },
  mobile: { calls: 150, geometries: 200, textures: 40, triangles: 300_000 },
};

const parseArgs = (argv) => {
  const opts = { json: false, minStd: 4, mobile: false, out: null, selector: "canvas", wait: 1500 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selector") {
      opts.selector = argv[(i += 1)];
    } else if (a === "--out") {
      opts.out = argv[(i += 1)];
    } else if (a === "--wait") {
      opts.wait = Number(argv[(i += 1)]);
    } else if (a === "--min-std") {
      opts.minStd = Number(argv[(i += 1)]);
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--mobile") {
      opts.mobile = true;
    } else {
      rest.push(a);
    }
  }
  [opts.target] = rest;
  // reject malformed numeric flags (e.g. a missing arg → NaN) rather than
  // silently treating NaN thresholds as "passing"
  if (!Number.isFinite(opts.wait) || opts.wait < 0) {
    throw new Error(`--wait must be a non-negative number (got ${opts.wait})`);
  }
  if (!Number.isFinite(opts.minStd) || opts.minStd < 0) {
    throw new Error(`--min-std must be a non-negative number (got ${opts.minStd})`);
  }
  return opts;
};

const toUrl = (target) => {
  if (/^https?:\/\//u.test(target) || target.startsWith("file://")) {
    return target;
  }
  // local file path → file:// URL
  return pathToFileURL(target).href;
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

/** Minimal PNG decoder: 8-bit, non-interlaced, color types 0/2/4/6. */
const decodePng = (buf) => {
  if (buf.readUInt32BE(0) !== 0x89_50_4e_47) {
    throw new Error("not a PNG");
  }
  let off = 8;
  let bitDepth = 8;
  let colorType = 6;
  let height = 0;
  let width = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      if (data.readUInt8(12) !== 0) {
        throw new Error("interlaced PNG unsupported");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) {
    throw new Error(`bit depth ${bitDepth} unsupported`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) {
    throw new Error(`color type ${colorType} unsupported`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[pos];
      pos += 1;
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let recon;
      switch (filter) {
        case 0: {
          recon = v;
          break;
        }
        case 1: {
          recon = v + a;
          break;
        }
        case 2: {
          recon = v + b;
          break;
        }
        case 3: {
          recon = v + Math.floor((a + b) / 2);
          break;
        }
        case 4: {
          recon = v + paeth(a, b, c);
          break;
        }
        default: {
          throw new Error(`bad filter ${filter}`);
        }
      }
      out[y * stride + x] = recon % 256;
    }
  }
  return { channels, data: out, height, width };
};

/** Luminance stddev + non-transparent fraction over a sampled grid. */
const analyze = ({ width, height, channels, data }) => {
  const stride = width * channels;
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  let n = 0;
  let opaque = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = y * stride + x * channels;
      let alpha;
      let b;
      let g;
      const r = data[i];
      if (channels >= 3) {
        g = data[i + 1];
        b = data[i + 2];
        alpha = channels === 4 ? data[i + 3] : 255;
      } else {
        g = r;
        b = r;
        alpha = channels === 2 ? data[i + 1] : 255;
      }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      sumSq += lum * lum;
      if (alpha > 8) {
        opaque += 1;
      }
      n += 1;
    }
  }
  if (n === 0) {
    return { meanLum: 0, opaqueFraction: 0, sampled: 0, stdLum: 0 };
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { meanLum: mean, opaqueFraction: opaque / n, sampled: n, stdLum: std };
};

const PAGE_OPTIONS = {
  desktop: { viewport: { height: 720, width: 1280 } },
  mobile: {
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  },
};

/** Compare `renderer.info` numbers against the tier's budget; null when the page exposes none. */
const renderBudget = (rendererInfo, tier) => {
  if (!rendererInfo) {
    return null;
  }
  return Object.entries(RENDER_BUDGETS[tier]).map(([metric, limit]) => ({
    actual: Number.isFinite(rendererInfo[metric]) ? rendererInfo[metric] : null,
    limit,
    metric,
    ok: Number.isFinite(rendererInfo[metric]) ? rendererInfo[metric] <= limit : null,
  }));
};

const failureReason = ({ blankLum, minStd, nearEmpty, pageErrors, stats }) => {
  if (pageErrors.length) {
    return `uncaught page error: ${pageErrors[0]}`;
  }
  if (nearEmpty) {
    return `near-empty canvas (opaque ${(stats.opaqueFraction * 100).toFixed(1)}% ≤ 1%)`;
  }
  if (blankLum) {
    return `blank/solid (stdLum ${stats.stdLum.toFixed(2)} < ${minStd})`;
  }
  return "rendered non-blank content";
};

const main = async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message || error));
    return 2;
  }
  if (!opts.target) {
    console.error(
      "usage: node check-canvas.mjs <url|file> [--selector css] [--out png] [--wait ms] [--min-std n] [--mobile] [--json]",
    );
    return 2;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "Playwright not found. Install it: pnpm add -D playwright (Chromium is pre-resolved in this environment).",
    );
    return 2;
  }

  // browser declared before the try so `finally` can always close it, even if
  // launch()/newPage() throws (otherwise a failure here leaks a Chromium process).
  let browser;
  // console.error() — advisory (benign 404s etc.)
  const consoleErrors = [];
  // uncaught exceptions — fail the check
  const pageErrors = [];
  try {
    browser = await chromium.launch();
    const tier = opts.mobile ? "mobile" : "desktop";
    const page = await browser.newPage(PAGE_OPTIONS[tier]);
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(toUrl(opts.target), { timeout: 30_000, waitUntil: "load" });
    // let assets load + a few frames render
    await page.waitForTimeout(opts.wait);

    const canvas = await page.$(opts.selector);
    if (!canvas) {
      report(opts, {
        consoleErrors,
        ok: false,
        pageErrors,
        reason: `no element matching "${opts.selector}"`,
      });
      return 2;
    }
    const png = await canvas.screenshot();
    if (opts.out) {
      writeFileSync(opts.out, png);
    }

    // Advisory render-budget check: only when the page exposes a diagnostics
    // snapshot (window.__GAME_DIAGNOSTICS__.renderer = renderer.info numbers).
    const rendererInfo = await page
      .evaluate(() => globalThis.__GAME_DIAGNOSTICS__?.renderer ?? null)
      .catch(() => null);
    const budget = renderBudget(rendererInfo, tier);

    const stats = analyze(decodePng(png));
    // positive comparisons negated, so a non-finite metric fails (never a false pass)
    const blankLum = !(stats.stdLum >= opts.minStd);
    const nearEmpty = !(stats.opaqueFraction > 0.01);
    // an uncaught page exception is a real render regression even if pixels drew
    const ok = !blankLum && !nearEmpty && pageErrors.length === 0;
    const reason = failureReason({ blankLum, minStd: opts.minStd, nearEmpty, pageErrors, stats });
    report(opts, { ok, reason, ...stats, budget, consoleErrors, out: opts.out, pageErrors, tier });
    return ok ? 0 : 1;
  } catch (error) {
    report(opts, { consoleErrors, ok: false, pageErrors, reason: String(error?.message || error) });
    return 2;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

const report = (opts, result) => {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.ok ? "PASS" : "FAIL"} — ${result.reason}`);
  if (result.stdLum !== undefined) {
    console.log(
      `  luminance stddev: ${result.stdLum.toFixed(2)}  mean: ${result.meanLum.toFixed(1)}  opaque: ${(result.opaqueFraction * 100).toFixed(1)}%`,
    );
  }
  if (result.out) {
    console.log(`  screenshot: ${result.out}`);
  }
  if (result.budget) {
    const over = result.budget.filter((row) => row.ok === false);
    const missing = result.budget.filter((row) => row.ok === null);
    if (over.length) {
      console.log(`  render budget (${result.tier} tier, advisory) — OVER:`);
      for (const row of over) {
        console.log(`    - ${row.metric}: ${row.actual} > ${row.limit}`);
      }
    } else if (missing.length === result.budget.length) {
      console.log(
        `  render budget (${result.tier} tier): diagnostics present but no numeric metrics — not validated`,
      );
    } else {
      console.log(`  render budget (${result.tier} tier): within limits`);
    }
    if (missing.length && missing.length < result.budget.length) {
      console.log(
        `    (not reported by diagnostics: ${missing.map((row) => row.metric).join(", ")})`,
      );
    }
  }
  if (result.pageErrors?.length) {
    console.log(`  uncaught page errors (${result.pageErrors.length}):`);
    for (const e of result.pageErrors.slice(0, 5)) {
      console.log(`    - ${e}`);
    }
  }
  if (result.consoleErrors?.length) {
    console.log(`  console errors (${result.consoleErrors.length}, advisory):`);
    for (const e of result.consoleErrors.slice(0, 5)) {
      console.log(`    - ${e}`);
    }
  }
};

process.exit(await main());
