// Social-preview capture: the site's og:video trailer and the per-page cards.
//
//   pnpm -F @repo/web og:video                # trailer + cards
//   pnpm -F @repo/web og:video --only video
//   pnpm -F @repo/web og:video --only cards
//
// The trailer is a built scene, not gameplay: scripts/og-scene.html is one
// continuous wireframe shot in which a single hero travels through five kinds
// of game — platformer, bomberman grid, paddle court, 3D arena, falling-block
// well — each re-forming into the next, then folds back into the icon over its
// tagline. It is opened from disk, never routed or shipped. This script hands
// it the icon's polygon from public/favicon/favicon.svg (`window.__setMark`),
// then steps `window.__render(ms)` one 30fps frame at a time at device pixel
// ratio 2 and screenshots each, so the cut is identical every run however
// slowly the machine draws. ffmpeg scales the frames down into a 1200x630
// H.264 loop at apps/web/public/og/og.mp4. The scene's `window.__still()`
// draws the trailer's poster (the icon and tagline over the clip's arena). The
// site's og:image (public/og.jpg) is the painted brand illustration, kept by
// hand: nothing here writes it.
//
// The cards are one 1200x630 JPEG per prose page (lib/og-media.ts), drawn from
// the page's own title and description over the site's logo, background and
// game covers. Nothing here runs in `pnpm verify` or the build.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const SCENE = path.join(WEB, "scripts/og-scene.html");
/** Frames are drawn at twice the size and scaled down, so hairlines stay crisp. */
const SCALE = 2;

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

// --- capture ---------------------------------------------------------------

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

/** The icon's polygon, read from the favicon so the clip never drifts from the logo. */
const markPoints = (): [number, number][] => {
  const svg = readFileSync(path.join(PUBLIC, "favicon/favicon.svg"), "utf-8");
  const points = /<polygon[^>]*points="(?<points>[^"]+)"/u.exec(svg)?.groups?.points;
  if (!points) {
    throw new Error("og-video: no polygon in public/favicon/favicon.svg");
  }
  const numbers = points.trim().split(/\s+/u).map(Number);
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    pairs.push([numbers[index] ?? 0, numbers[index + 1] ?? 0]);
  }
  return pairs;
};

const frameName = (index: number) => `${String(index).padStart(5, "0")}.png`;

const captureVideo = async (browser: Browser) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "vg-og-video-"));
  const context = await browser.newContext({
    deviceScaleFactor: SCALE,
    viewport: { height: HEIGHT, width: WIDTH },
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(SCENE).href, { waitUntil: "load" });
    await page.waitForFunction("typeof window.__setMark === 'function'", undefined, {
      polling: 100,
      timeout: 30_000,
    });
    // No text exists yet, so nothing has requested VG5000: load it by name, or the
    // first frames bake in the fallback face.
    const fontLoaded = await page.evaluate(
      "document.fonts.load('16px VG5000').then((faces) => faces.length > 0)",
    );
    if (fontLoaded !== true) {
      throw new Error("og-video: VG5000 did not load");
    }
    await page.evaluate(`window.__setMark(${JSON.stringify(markPoints())})`);
    const duration = Number(await page.evaluate("window.__duration"));
    const frameCount = Math.round((duration / 1000) * FPS);
    const expected = Number(siteVideo.duration.replaceAll(/\D/gu, "")) * FPS;
    if (frameCount !== expected) {
      throw new Error(
        `og-video: the scene runs ${duration}ms, og-media says ${siteVideo.duration}`,
      );
    }
    for (let frame = 0; frame < frameCount; frame += 1) {
      await page.evaluate(`window.__render(${(frame * 1000) / FPS})`);
      await page.screenshot({ path: path.join(scratch, frameName(frame)), type: "png" });
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
      path.join(scratch, "%05d.png"),
      "-vf",
      `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-movflags",
      "+faststart",
      out,
    ]);
    // The poster: one still, drawn by the scene at full size.
    const still = path.join(scratch, "still.png");
    await page.evaluate("window.__still()");
    await page.screenshot({ path: still, type: "png" });
    await exec("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      still,
      "-vf",
      `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      "-q:v",
      "3",
      path.join(PUBLIC, siteVideo.poster),
    ]);
    const { size } = await stat(out);
    console.log(`og-video: ${path.relative(ROOT, out)} — ${await ffprobe(out)}`);
    if (size > 2.5 * 1024 * 1024) {
      throw new Error(`og-video: ${size} bytes is over the 2.5 MB budget; raise -crf`);
    }
  } finally {
    await context.close();
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
