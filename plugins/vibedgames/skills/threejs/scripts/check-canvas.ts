#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import type { Browser, BrowserType, Page } from "playwright";

type Tier = "desktop" | "mobile";

interface Options {
  json: boolean;
  minStd: number;
  mobile: boolean;
  out: string | null;
  selector: string;
  target: string | null;
  wait: number;
}

interface Stats {
  meanLum: number;
  opaqueFraction: number;
  sampled: number;
  stdLum: number;
}

interface BudgetRow {
  actual: number | null;
  limit: number;
  metric: string;
  ok: boolean | null;
}

interface GpuInfo {
  renderer: string | null;
  softwareRendered: boolean | null;
  vendor: string | null;
}

interface Result extends Partial<Stats> {
  budget?: BudgetRow[] | null;
  consoleErrors: string[];
  gpu?: GpuInfo;
  ok: boolean;
  out?: string | null;
  pageErrors: string[];
  reason: string;
  tier?: Tier;
}

const printHelp = () => {
  const source = readFileSync(import.meta.filename, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);

  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();

  process.stdout.write(`${text === "" ? "No help available." : text}\n`);
};

const RENDER_BUDGETS = {
  desktop: { calls: 300, geometries: 300, textures: 60, triangles: 750_000 },
  mobile: { calls: 150, geometries: 200, textures: 40, triangles: 300_000 },
};

const parseArgs = (argv: string[]) => {
  const opts: Options = {
    json: false,
    minStd: 4,
    mobile: false,
    out: null,
    selector: "canvas",
    target: null,
    wait: 1500,
  };

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";

    if (a === "--selector") {
      opts.selector = argv[(i += 1)] ?? "";
    } else if (a === "--out") {
      opts.out = argv[(i += 1)] ?? null;
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

  opts.target = rest[0] ?? null;

  if (!Number.isFinite(opts.wait) || opts.wait < 0) {
    throw new Error(`--wait must be a non-negative number (got ${opts.wait})`);
  }

  if (!Number.isFinite(opts.minStd) || opts.minStd < 0) {
    throw new Error(`--min-std must be a non-negative number (got ${opts.minStd})`);
  }

  return opts;
};

const toUrl = (target: string) => {
  if (/^https?:\/\//u.test(target) || target.startsWith("file://")) {
    return target;
  }

  return pathToFileURL(target).href;
};

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  if (pa <= pb && pa <= pc) {
    return a;
  }

  return pb <= pc ? b : c;
};

const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [4, 2],
  [6, 4],
]);

const unfilter = (filter: number, v: number, a: number, b: number, c: number) => {
  switch (filter) {
    case 0: {
      return v;
    }

    case 1: {
      return v + a;
    }

    case 2: {
      return v + b;
    }

    case 3: {
      return v + Math.floor((a + b) / 2);
    }

    case 4: {
      return v + paeth(a, b, c);
    }

    default: {
      throw new Error(`bad filter ${filter}`);
    }
  }
};

const readChunks = (buf: Buffer) => {
  let off = 8;
  let bitDepth = 8;
  let colorType = 6;
  let height = 0;
  let width = 0;
  const idat: Buffer[] = [];

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

  return { bitDepth, colorType, height, idat, width };
};

const decodePng = (buf: Buffer) => {
  if (buf.readUInt32BE(0) !== 0x89_50_4e_47) {
    throw new Error("not a PNG");
  }

  const { bitDepth, colorType, height, idat, width } = readChunks(buf);

  if (bitDepth !== 8) {
    throw new Error(`bit depth ${bitDepth} unsupported`);
  }

  const channels = CHANNELS.get(colorType);

  if (channels === undefined) {
    throw new Error(`color type ${colorType} unsupported`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos] ?? 0;
    pos += 1;

    for (let x = 0; x < stride; x += 1) {
      const v = raw[pos] ?? 0;
      pos += 1;
      const a = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      out[y * stride + x] = unfilter(filter, v, a, b, c) % 256;
    }
  }

  return { channels, data: out, height, width };
};

const analyze = ({
  width,
  height,
  channels,
  data,
}: {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}) => {
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
      let alpha = 255;
      let b = 0;
      let g = 0;
      const r = data[i] ?? 0;

      if (channels >= 3) {
        g = data[i + 1] ?? 0;
        b = data[i + 2] ?? 0;
        alpha = channels === 4 ? (data[i + 3] ?? 0) : 255;
      } else {
        g = r;
        b = r;
        alpha = channels === 2 ? (data[i + 1] ?? 0) : 255;
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
    const empty: Stats = { meanLum: 0, opaqueFraction: 0, sampled: 0, stdLum: 0 };

    return empty;
  }

  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const stats: Stats = { meanLum: mean, opaqueFraction: opaque / n, sampled: n, stdLum: std };

  return stats;
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

const renderBudget = (rendererInfo: Record<string, number> | null, tier: Tier) => {
  if (rendererInfo === null) {
    return null;
  }

  return Object.entries(RENDER_BUDGETS[tier]).map(([metric, limit]) => {
    const value = Object.hasOwn(rendererInfo, metric) ? rendererInfo[metric] : undefined;
    const actual = value !== undefined && Number.isFinite(value) ? value : null;
    const row: BudgetRow = { actual, limit, metric, ok: actual === null ? null : actual <= limit };

    return row;
  });
};

const launchBrowser: (
  chromium: BrowserType,
  channels?: readonly string[],
) => Promise<Browser> = async (chromium, channels = ["chrome", "chromium"]) => {
  const [channel, ...rest] = channels;

  if (channel !== undefined) {
    try {
      return await chromium.launch({ channel });
    } catch {
      return await launchBrowser(chromium, rest);
    }
  }

  console.error(
    [
      'warning: neither channel "chrome" nor "chromium" is available; falling back to the bundled headless shell.',
      "  Rendering will be software (SwiftShader) and any FPS/frame-time evidence is invalid.",
      "  Fix with: npx playwright install chromium",
    ].join("\n"),
  );

  return await chromium.launch();
};

const readGpuInfo = async (page: Page) => {
  const info = await page
    .evaluate(() => {
      const canvas = document.querySelector("canvas");
      let gl = null;

      try {
        gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null;
      } catch {
        gl = null;
      }

      if (!gl) {
        return null;
      }

      const debug = gl.getExtension("WEBGL_debug_renderer_info");

      const read = (name: number) => {
        const value: unknown = gl?.getParameter(name);

        return String(value) === value ? value : null;
      };

      return {
        renderer: read(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL),
        vendor: read(debug === null ? gl.VENDOR : debug.UNMASKED_VENDOR_WEBGL),
      };
    })
    .catch(() => null);

  const renderer = info?.renderer ?? null;

  if (renderer === null || renderer === "") {
    const unknown: GpuInfo = { renderer: null, softwareRendered: null, vendor: null };

    return unknown;
  }

  const gpu: GpuInfo = {
    renderer,
    softwareRendered: /swiftshader|llvmpipe|software|basic render/iu.test(renderer),
    vendor: info?.vendor ?? null,
  };

  return gpu;
};

const failureReason = ({
  blankLum,
  minStd,
  nearEmpty,
  pageErrors,
  stats,
}: {
  blankLum: boolean;
  minStd: number;
  nearEmpty: boolean;
  pageErrors: string[];
  stats: Stats;
}) => {
  if (pageErrors.length > 0) {
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

const messageOf = (error: Error | string) =>
  error instanceof Error && error.message !== "" ? error.message : String(error);

const readOptions = (argv: string[]) => {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error(messageOf(error instanceof Error ? error : String(error)));

    return null;
  }
};

const loadChromium = async () => {
  try {
    const { chromium } = await import("playwright");

    return chromium;
  } catch {
    return null;
  }
};

const main = async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();

    return 0;
  }

  const opts = readOptions(process.argv.slice(2));

  if (opts === null) {
    return 2;
  }

  const { target } = opts;

  if (target === null || target === "") {
    console.error(
      "usage: node check-canvas.ts <url|file> [--selector css] [--out png] [--wait ms] [--min-std n] [--mobile] [--json]",
    );

    return 2;
  }

  const chromium = await loadChromium();

  if (chromium === null) {
    console.error(
      "Playwright not found. Install it: pnpm add -D playwright (Chromium is pre-resolved in this environment).",
    );

    return 2;
  }

  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    browser = await launchBrowser(chromium);
    const tier: Tier = opts.mobile ? "mobile" : "desktop";
    const page = await browser.newPage(PAGE_OPTIONS[tier]);

    page.on("console", (m) => {
      if (m.type() === "error") {
        consoleErrors.push(m.text());
      }
    });

    page.on("pageerror", (e) => {
      pageErrors.push(String(e));
    });

    await page.goto(toUrl(target), { timeout: 30_000, waitUntil: "load" });
    await page.waitForTimeout(opts.wait);

    const canvas = await page.$(opts.selector);

    if (canvas === null) {
      report(opts, {
        consoleErrors,
        ok: false,
        pageErrors,
        reason: `no element matching "${opts.selector}"`,
      });

      return 2;
    }

    const png = await canvas.screenshot();

    if (opts.out !== null && opts.out !== "") {
      writeFileSync(opts.out, png);
    }

    const rendererInfo = await page
      .evaluate(() => {
        const diagnostics = globalThis.__GAME_DIAGNOSTICS__;

        const renderer =
          diagnostics !== undefined && "renderer" in diagnostics ? diagnostics.renderer : null;

        const present = Boolean(renderer);

        if (!present) {
          return null;
        }

        const fields: [string, unknown][] =
          renderer instanceof Object ? Object.entries(renderer) : [];

        return Object.fromEntries(
          fields.filter((field): field is [string, number] => Number(field[1]) === field[1]),
        );
      })
      .catch(() => null);

    const budget = renderBudget(rendererInfo, tier);
    const gpu = await readGpuInfo(page);

    const stats = analyze(decodePng(png));
    const blankLum = !(stats.stdLum >= opts.minStd);
    const nearEmpty = !(stats.opaqueFraction > 0.01);
    const ok = !blankLum && !nearEmpty && pageErrors.length === 0;
    const reason = failureReason({ blankLum, minStd: opts.minStd, nearEmpty, pageErrors, stats });
    report(opts, {
      ok,
      reason,
      ...stats,
      budget,
      consoleErrors,
      gpu,
      out: opts.out,
      pageErrors,
      tier,
    });

    return ok ? 0 : 1;
  } catch (error) {
    report(opts, {
      consoleErrors,
      ok: false,
      pageErrors,
      reason: messageOf(error instanceof Error ? error : String(error)),
    });

    return 2;
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
};

const reportGpu = (gpu: GpuInfo) => {
  if (gpu.renderer === null) {
    console.log("  gpu: no WebGL context on the canvas — renderer unknown");
  } else if (gpu.softwareRendered === true) {
    console.log(
      `  gpu: ${gpu.renderer} (SOFTWARE) — pixel/budget/functional checks valid; FPS and frame-time numbers from this run are NOT performance evidence`,
    );
  } else {
    console.log(`  gpu: ${gpu.renderer}`);
  }
};

const reportBudget = (budget: BudgetRow[], tier: Tier) => {
  const over = budget.filter((row) => row.ok === false);
  const missing = budget.filter((row) => row.ok === null);

  if (over.length > 0) {
    console.log(`  render budget (${tier} tier, advisory) — OVER:`);

    for (const row of over) {
      console.log(`    - ${row.metric}: ${row.actual ?? "null"} > ${row.limit}`);
    }
  } else if (missing.length === budget.length) {
    console.log(
      `  render budget (${tier} tier): diagnostics present but no numeric metrics — not validated`,
    );
  } else {
    console.log(`  render budget (${tier} tier): within limits`);
  }

  if (missing.length > 0 && missing.length < budget.length) {
    console.log(
      `    (not reported by diagnostics: ${missing.map((row) => row.metric).join(", ")})`,
    );
  }
};

const report = (opts: Options, result: Result) => {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));

    return;
  }

  console.log(`${result.ok ? "PASS" : "FAIL"} — ${result.reason}`);

  const { meanLum, opaqueFraction, stdLum } = result;

  if (stdLum !== undefined && meanLum !== undefined && opaqueFraction !== undefined) {
    console.log(
      `  luminance stddev: ${stdLum.toFixed(2)}  mean: ${meanLum.toFixed(1)}  opaque: ${(opaqueFraction * 100).toFixed(1)}%`,
    );
  }

  if (result.out !== undefined && result.out !== null && result.out !== "") {
    console.log(`  screenshot: ${result.out}`);
  }

  if (result.gpu !== undefined) {
    reportGpu(result.gpu);
  }

  if (result.budget !== undefined && result.budget !== null) {
    reportBudget(result.budget, result.tier ?? "desktop");
  }

  if (result.pageErrors.length > 0) {
    console.log(`  uncaught page errors (${result.pageErrors.length}):`);

    for (const e of result.pageErrors.slice(0, 5)) {
      console.log(`    - ${e}`);
    }
  }

  if (result.consoleErrors.length > 0) {
    console.log(`  console errors (${result.consoleErrors.length}, advisory):`);

    for (const e of result.consoleErrors.slice(0, 5)) {
      console.log(`    - ${e}`);
    }
  }
};

process.exit(await main());
