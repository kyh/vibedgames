// Social-preview capture: the site's og:video montage and the per-page cards.
//
//   pnpm -F @repo/web og:video            # montage + cards
//   pnpm -F @repo/web og:video --only video
//   pnpm -F @repo/web og:video --only cards
//   pnpm -F @repo/web og:video --only video --clips starfall:17:300,lunerfall:3:400
//
// The montage is real gameplay, not a render: each bundled example game in
// CLIPS runs under its own Vite dev server (the server `pnpm dev:<game>`
// starts; a running one is reused), opens its scripted `?trailer=1` run, jumps
// to one scene and is recorded for a couple of seconds. The cuts are joined
// into one 8s 1200x630 H.264 loop at apps/web/public/og/og.mp4, with its first
// frame as og-poster.jpg.
//
// Why frame-stepped instead of Playwright's recordVideo: these games draw a few
// frames a second under headless Chromium's software WebGL, so a live
// recording is a slideshow. An init script puts the page on a virtual clock —
// `performance.now`, `Date.now`, requestAnimationFrame and timers all read it —
// then advances it exactly one 30fps frame per screenshot. The trailer's own
// choreography runs off that clock, so every frame on disk is one the game
// would have shown at full speed.
//
// The cards are one 1200x630 JPEG per prose page (lib/og-media.ts), drawn from
// the page's own title and description over the site's logo, background and
// game covers. Nothing here runs in `pnpm verify` or the build.

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import type { Doc } from "@/lib/doc";
import { featuredGames } from "@/components/game/data";
import { aboutDoc } from "@/content/about";
import { buildDoc } from "@/content/build";
import { contactDoc } from "@/content/contact";
import { discoverDoc } from "@/content/discover";
import { docsDoc } from "@/content/docs";
import { privacyDoc } from "@/content/privacy";
import { termsDoc } from "@/content/terms";
import { PAGE_CARD_PATHS, pageImage, siteVideo } from "@/lib/og-media";
import { siteConfig } from "@/lib/site-config";

const exec = promisify(execFile);
const WEB = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(WEB, "../..");
const PUBLIC = path.join(WEB, "public");

const FPS = 30;
const WIDTH = siteVideo.width;
const HEIGHT = siteVideo.height;
/** The trailers letterbox to 16:9, so frame at 16:9 and crop the middle 630px. */
const VIEWPORT = { height: Math.round((WIDTH * 9) / 16), width: WIDTH };
const CROP_TOP = Math.round((VIEWPORT.height - HEIGHT) / 2);

interface Clip {
  game: string;
  /** Index into the game's trailer scene list (`window.__trailerJump`). */
  scene: number;
  /** Where in the scene the cut starts, in scene milliseconds. */
  fromMs: number;
}

/**
 * The cuts, in order. Four games, two seconds each: 8s at 30fps. Picked for
 * motion that reads at thumbnail size; a scene index follows the game's
 * trailer-director.ts, so re-check it when a trailer is re-cut.
 */
const DEFAULT_CLIPS: Clip[] = [
  { fromMs: 300, game: "starfall", scene: 17 },
  { fromMs: 800, game: "battle-arena", scene: 11 },
  { fromMs: 300, game: "lunerfall", scene: 0 },
  { fromMs: 300, game: "starfall", scene: 8 },
];
/** `--clips game:scene:fromMs,...` re-cuts the montage without editing this file. */
const CLIPS: Clip[] = (() => {
  const at = process.argv.indexOf("--clips");
  const spec: string | undefined = at === -1 ? undefined : process.argv[at + 1];
  if (!spec) {
    return DEFAULT_CLIPS;
  }
  return spec.split(",").map((part: string) => {
    const [game = "", scene = "0", fromMs = "0"] = part.split(":");
    return { fromMs: Number(fromMs), game, scene: Number(scene) };
  });
})();
const CLIP_FRAMES = Math.round(
  (Number(siteVideo.duration.replaceAll(/\D/gu, "")) * FPS) / CLIPS.length,
);

const CARD_DOCS: Doc[] = [
  discoverDoc,
  buildDoc,
  docsDoc,
  aboutDoc,
  contactDoc,
  privacyDoc,
  termsDoc,
];

// --- Playwright, typed to the few calls made here --------------------------

/** What a page expression hands back here: a number, a string or a flag. */
type Evaluated = boolean | number | string | null;

interface Page {
  addInitScript: (script: string) => Promise<void>;
  evaluate: (expression: string) => Promise<Evaluated>;
  goto: (url: string, options?: { timeout?: number; waitUntil?: string }) => Promise<void>;
  screenshot: (options: {
    clip?: { height: number; width: number; x: number; y: number };
    path: string;
    quality?: number;
    type: "jpeg" | "png";
  }) => Promise<void>;
  setContent: (html: string, options?: { waitUntil?: string }) => Promise<void>;
  waitForFunction: (
    expression: string,
    arg: undefined,
    options?: { polling?: number; timeout?: number },
  ) => Promise<void>;
}
interface Context {
  close: () => Promise<void>;
  newPage: () => Promise<Page>;
}
interface Browser {
  close: () => Promise<void>;
  newContext: (options: {
    deviceScaleFactor: number;
    viewport: { height: number; width: number };
  }) => Promise<Context>;
}
interface Playwright {
  chromium: { launch: () => Promise<Browser> };
}

/**
 * `playwright` where the machine has it (global installs ship a matching
 * Chromium), else the `playwright-core` the game packages already depend on —
 * tooling only, so neither becomes a dependency of the web app.
 */
const loadPlaywright = (): Playwright => {
  const candidates: [string, string][] = [
    [path.join(WEB, "package.json"), "playwright"],
    [path.join(ROOT, "games/crazy-waymo/package.json"), "playwright-core"],
  ];
  for (const [from, name] of candidates) {
    try {
      const loaded: Playwright = createRequire(from)(name);
      return loaded;
    } catch {
      // try the next one
    }
  }
  throw new Error("og-video: no playwright or playwright-core to drive Chromium with");
};

// --- the virtual clock -----------------------------------------------------

/**
 * Installed before any game code runs. Real time until `__og.freeze()`, then
 * time moves only when `__og.step(ms)` says so: rAF callbacks and due timers
 * fire inside the step, with the clock at the new time.
 */
const CLOCK = `(() => {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancelRaf = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const epoch = Date.now() - realNow();
  let frozen = false;
  let now = 0;
  let nextId = 1e9;
  const frames = new Map();
  const timers = new Map();
  const read = () => (frozen ? now : realNow());
  performance.now = read;
  Date.now = () => Math.round(epoch + read());
  window.requestAnimationFrame = (cb) => {
    if (!frozen) return realRaf((t) => cb(read()));
    const id = nextId++;
    frames.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => { frames.delete(id); realCancelRaf(id); };
  const later = (repeat) => (cb, ms = 0, ...args) => {
    if (!frozen) return (repeat ? realSetInterval : realSetTimeout)(cb, ms, ...args);
    const id = nextId++;
    timers.set(id, { args, at: now + Math.max(0, ms), cb, every: repeat ? Math.max(1, ms) : 0 });
    return id;
  };
  window.setTimeout = later(false);
  window.setInterval = later(true);
  window.clearTimeout = (id) => { timers.delete(id); realClearTimeout(id); };
  window.clearInterval = (id) => { timers.delete(id); realClearInterval(id); };
  const run = (fn, ...args) => { try { if (typeof fn === "function") fn(...args); } catch (e) { console.error(e); } };
  window.__og = {
    freeze() { if (!frozen) { now = realNow(); frozen = true; } },
    step(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every; else timers.delete(id);
        run(t.cb, ...t.args);
      }
      now = target;
      const cbs = [...frames.values()];
      frames.clear();
      for (const cb of cbs) run(cb, now);
    },
  };
})();`;

// --- dev servers -----------------------------------------------------------

const devPort = (game: string) => {
  const config = readFileSync(path.join(ROOT, "games", game, "vite.config.ts"), "utf-8");
  const port = /port:\s*(?<port>\d+)/u.exec(config)?.groups?.port;
  if (!port) {
    throw new Error(`og-video: games/${game}/vite.config.ts names no dev port`);
  }
  return Number(port);
};

const isUp = async (url: string) => {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
};

/** The game's own dev server: reused when one is already listening. */
const startServer = async (game: string): Promise<ChildProcess | null> => {
  const url = `http://localhost:${devPort(game)}/`;
  if (await isUp(url)) {
    return null;
  }
  const child = spawn("pnpm", ["--filter", `@repo/${game}`, "dev", "--strictPort"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      return child;
    }
    await sleep(500);
  }
  throw new Error(`og-video: ${game}'s dev server never came up on ${url}`);
};

const stopServer = (child: ChildProcess | null) => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
};

// --- capture ---------------------------------------------------------------

const captureClip = async (browser: Browser, clip: Clip, folder: string) => {
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.addInitScript(CLOCK);
    await page.goto(`http://localhost:${devPort(clip.game)}/?trailer=1&offline=1`, {
      timeout: 180_000,
      waitUntil: "load",
    });
    await page.waitForFunction("Boolean(window.__trailer && window.__trailerJump)", undefined, {
      polling: 250,
      timeout: 300_000,
    });
    // Freeze first, then jump: the cut, the scene's setup and its timers all
    // run on the virtual clock, so the scene starts at t = 0 however slowly
    // the page draws, and `fromMs` lands on the same frame every run.
    await page.evaluate("window.__og.freeze()");
    await page.evaluate(`window.__trailerJump(${clip.scene})`);
    const frameMs = 1000 / FPS;
    const live = `window.__trailer.sceneIndex === ${clip.scene} && window.__trailer.t >= ${clip.fromMs}`;
    for (let steps = 0; !(await page.evaluate(live)); steps += 1) {
      if (steps > 3000) {
        throw new Error(`og-video: ${clip.game} never reached scene ${clip.scene}`);
      }
      await page.evaluate(`window.__og.step(${frameMs})`);
    }
    for (let frame = 0; frame < CLIP_FRAMES; frame += 1) {
      await page.evaluate(`window.__og.step(${frameMs})`);
      await page.screenshot({
        clip: { height: HEIGHT, width: WIDTH, x: 0, y: CROP_TOP },
        path: path.join(folder, `${String(frame).padStart(4, "0")}.png`),
        type: "png",
      });
    }
    const scene = String(await page.evaluate("window.__trailer.sceneId"));
    console.log(`og-video: ${clip.game} "${scene}" — ${CLIP_FRAMES} frames`);
  } finally {
    await context.close();
  }
};

const ffprobe = async (file: string) => {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height:format=duration,size",
    "-of",
    "default=nw=1",
    file,
  ]);
  return stdout.trim().replaceAll("\n", " ");
};

const captureVideo = async (browser: Browser) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "vg-og-video-"));
  const frames = path.join(scratch, "frames");
  await mkdir(frames);
  try {
    let index = 0;
    for (const [n, clip] of CLIPS.entries()) {
      const folder = path.join(scratch, `clip-${n}`);
      await mkdir(folder);
      const server = await startServer(clip.game);
      try {
        await captureClip(browser, clip, folder);
      } finally {
        stopServer(server);
      }
      const files = await readdir(folder);
      for (const file of files.toSorted()) {
        await copyFile(
          path.join(folder, file),
          path.join(frames, `${String(index).padStart(5, "0")}.png`),
        );
        index += 1;
      }
    }

    const out = path.join(PUBLIC, siteVideo.path);
    await mkdir(path.dirname(out), { recursive: true });
    await exec("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(FPS),
      "-i",
      path.join(frames, "%05d.png"),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-movflags",
      "+faststart",
      out,
    ]);
    await exec("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      path.join(frames, "00000.png"),
      "-q:v",
      "3",
      path.join(PUBLIC, siteVideo.poster),
    ]);
    const { size } = await stat(out);
    console.log(`og-video: ${path.relative(ROOT, out)} — ${await ffprobe(out)}`);
    if (size > 4 * 1024 * 1024) {
      throw new Error(`og-video: ${size} bytes is over the 4 MB cap; raise -crf`);
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
};

// --- cards -----------------------------------------------------------------

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const dataUri = (file: string, type: string) =>
  `data:${type};base64,${readFileSync(path.join(PUBLIC, file)).toString("base64")}`;

/** The logo mark from public/favicon/favicon.svg, without its rounded tile. */
const LOGO =
  '<svg viewBox="180 270 670 490" width="112" height="82"><polygon fill="#fff" points="193.5 284.962 463.722 282 419.278 348.635 328.611 348.635 513.5 610.731 694.833 350.115 602.389 350.115 513.5 477.462 467.278 413.788 556.167 282 833.5 282 511.722 744"/></svg>';

const cardHtml = (doc: Doc) => {
  const covers = featuredGames
    .slice(0, 5)
    .map((game) => `<img src="${dataUri(game.preview, "image/webp")}" alt="">`)
    .join("");
  const title = doc.title.replace(` — ${siteConfig.name}`, "");
  return `<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; color: #fafafa;
    font-family: Inter, "Helvetica Neue", Arial, sans-serif;
    background: #0a0a0c url(${dataUri("bg.webp", "image/webp")}); background-size: 10px; }
  main { position: absolute; inset: 0; padding: 64px 72px; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 20px; font-size: 30px; font-weight: 600; letter-spacing: 0.02em; }
  h1 { margin-top: 56px; font-size: 76px; line-height: 1.05; font-weight: 700; letter-spacing: -0.02em; max-width: 1000px; }
  p { margin-top: 24px; font-size: 30px; line-height: 1.35; color: #a1a1aa; max-width: 980px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  footer { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; }
  .url { font-size: 26px; color: #d4d4d8; }
  .covers { display: flex; gap: 10px; }
  .covers img { width: 128px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid #ffffff22; }
  </style></head><body><main>
  <header>${LOGO}<span>${escapeHtml(siteConfig.name)}</span></header>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(doc.description)}</p>
  <footer><span class="url">${escapeHtml(siteConfig.url.replace("https://", ""))}${escapeHtml(doc.path)}</span>
  <div class="covers">${covers}</div></footer>
  </main></body></html>`;
};

const renderCards = async (browser: Browser) => {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { height: HEIGHT, width: WIDTH },
  });
  try {
    const page = await context.newPage();
    for (const cardPath of PAGE_CARD_PATHS) {
      const doc = CARD_DOCS.find((candidate) => candidate.path === cardPath);
      if (!doc) {
        throw new Error(`og-video: no Doc for card ${cardPath}`);
      }
      const out = path.join(PUBLIC, pageImage(cardPath));
      await mkdir(path.dirname(out), { recursive: true });
      await page.setContent(cardHtml(doc), { waitUntil: "load" });
      await page.screenshot({ path: out, quality: 86, type: "jpeg" });
      console.log(`og-video: ${path.relative(ROOT, out)}`);
    }
  } finally {
    await context.close();
  }
};

// --- main ------------------------------------------------------------------

const only = (() => {
  const at = process.argv.indexOf("--only");
  return at === -1 ? null : process.argv[at + 1];
})();

const main = async () => {
  if (!existsSync(path.join(ROOT, "games"))) {
    throw new Error("og-video: run from inside the vibedgames checkout");
  }
  const browser = await loadPlaywright().chromium.launch();
  try {
    if (only !== "cards") {
      await captureVideo(browser);
    }
    if (only !== "video") {
      await renderCards(browser);
    }
  } finally {
    await browser.close();
  }
};

await main();
