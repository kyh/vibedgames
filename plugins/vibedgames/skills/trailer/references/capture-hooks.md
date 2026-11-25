# Making a game filmable

Film and screenshot tests need the same thing: a take that repeats exactly,
at any speed, with any camera, and no stray HUD. Build these hooks into the
game itself, each off by default, each changing only what it declares, and
stripped from the public build (`import.meta.env.DEV` or a `?capture=1` flag
the production build ignores). `playtest` → `references/canvas-determinism.md`
covers the same ideas for tests.

## The checklist

1. **The host steps one clock.** In capture mode the game does not run on
   `requestAnimationFrame`. The capture script calls `step(n)`, which advances
   the simulation by a fixed `dt` per output frame and renders once. No game
   code reads `performance.now()` or `Date.now()` directly; everything reads
   the game clock.
2. **One time scale, and every timer obeys it.** Hitstop, shake, camera
   lerps, particles, physics, tweens, emitters, flashes and audio scheduling
   all run on scaled game time, so quarter speed looks like the same effect
   slowed down. A timer that ignores the scale shows up as an effect that
   finishes early in slow motion.
3. **One seed makes a take repeat.** All randomness comes from a seeded PRNG
   (e.g. mulberry32). Same seed + clock + scripted input = same frames.
4. **Scripted input.** A take's input is data (`[{frame: 120, press:
   "jump"}, …]`) fed through the same input layer the player uses, not
   teleports or state pokes.
5. **A director camera that wins.** When set, it overrides gameplay and
   cutscene cameras. A cut resets camera history (no smoothing carried across
   shots, no motion blur or TAA history smeared from the last shot).
6. **A clean feed, element by element.** Each HUD element and world marker
   can be hidden on its own, and music and voice can each be muted, from the
   launch URL.
7. **Ready means resident.** One awaitable state (`__CAPTURE__.ready`) that
   is true only when every model, texture, shader and sound the scene needs is
   loaded and quality is locked. A load failure reports itself.
8. **Commands are acknowledged by frame.** Every request names the
   simulation frame it applies to, and the game answers with the frame it ran
   on, so the script never guesses.
9. **A state probe.** On request the game reports camera, player, key enemy
   and objective positions in render space, from the same snapshot it drew,
   so you can check "hero in frame" by numbers.
10. **Audio per bus at simulation rate.** Stems for music, voice, effects
    and ambience, captured on the game clock (record the master tap from
    `audio` → `references/qa-without-ears.md` per bus, or log every sound
    event with its game time and rebuild the mix offline).

## A minimal capture API

```ts
// src/capture.ts — imported only when the capture flag is on
export type CaptureApi = {
  ready: Promise<void>;
  seed: (n: number) => void;
  timeScale: (s: number) => void;
  step: (frames: number) => number; // returns the frame it ended on
  camera: (path: CameraKey[] | null) => void; // null hands control back
  hide: (ids: string[]) => void; // HUD element ids, "music", "voice"
  input: (script: InputEvent[]) => void;
  probe: () => { frame: number; camera: number[]; player: number[]; enemies: number[][] };
};

declare global {
  interface Window {
    __CAPTURE__?: CaptureApi;
  }
}
```

## Frame-stepped capture to video

Real-time screen recording drops frames under load and cannot do real slow
motion. Step instead, and read every frame from the canvas:

```js
// capture-take.mjs — node capture-take.mjs <url> <frames> <out.mp4>
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const [url, frames, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-angle=gl"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${url}?capture=1&seed=7`);
await page.evaluate(() => window.__CAPTURE__.ready);

const ff = spawn(
  "ffmpeg",
  [
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    "60",
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "14",
    out,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);

for (let i = 0; i < Number(frames); i++) {
  const b64 = await page.evaluate(() => {
    window.__CAPTURE__.step(1);
    return document.querySelector("canvas").toDataURL("image/png").split(",")[1];
  });
  ff.stdin.write(Buffer.from(b64, "base64"));
}
ff.stdin.end();
await browser.close();
```

The renderer needs `preserveDrawingBuffer: true` in capture mode (or read the
pixels in the same task as the render). For a slow-motion span, set
`timeScale(0.25)` and keep stepping: four times the frames, every one real.

## Before batching

- Prove the capture tool on one frame: compare it with what the screen shows,
  check colour (sRGB) and that the first frame isn't black.
- A capture proves its own label: log the build, seed, camera and frame with
  every file, and reject frames where the probe says the hero is off screen.
- Batch every shot for one look into one job; don't open more browsers than
  the GPU can hold.
