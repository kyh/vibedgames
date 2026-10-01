#!/usr/bin/env node
/**
 * ref-sxs — put a locked reference screenshot beside a live game capture at
 * matched height, plus a blurred variant for the blur test (same genre? same
 * production tier?). Left = ref (red strip on top), right = game (green strip).
 *
 * Usage:
 *   node ref-sxs.mjs --ref refs/ref-01.png --game captures/still-01.png --out captures/sxs-01.png
 *   node ref-sxs.mjs --ref a.png --game b.png --out sxs.png --height 1080 --blur 32
 *
 * Writes `<out>` and `<out minus .png>-blur.png`. The blur variant shrinks each
 * half by `--blur` (default 24) with a filtered resample, scales it back up, and
 * halves the composite — text goes unreadable, value structure, palette, density
 * and light direction stay. `--height` (default 720) is the matched half height.
 *
 * PNG only. Convert a JPEG or WebP ref first (`magick ref.jpg ref.png`, or open it
 * with `vg playtest open` and take a `screenshot`). Transparent pixels flatten
 * onto black. The composite is for review only: never copy it into the game.
 */
import { existsSync } from "node:fs";

import {
  Bitmap,
  fail,
  failUsage,
  getInt,
  getString,
  main,
  parseArgs,
} from "./_lib/asset-tools.mjs";

const GAP = 8;
const STRIP = 6;
const BACKGROUND = [16, 16, 16, 255];
const REF_INK = [220, 60, 60, 255];
const GAME_INK = [60, 200, 90, 255];

const load = (file, role) => {
  if (!file) {
    failUsage(`--${role} is required (a PNG path)`);
  }
  if (!existsSync(file)) {
    fail(`${role} not found: ${file}`);
  }
  return Bitmap.fromFile(file).flatten([0, 0, 0]);
};

const fitHeight = (image, height) =>
  image.resize(Math.max(1, Math.round((image.width * height) / image.height)), height, "bilinear");

const soften = (image, factor) =>
  image
    .resize(
      Math.max(1, Math.round(image.width / factor)),
      Math.max(1, Math.round(image.height / factor)),
      "bilinear",
    )
    .resize(image.width, image.height, "bilinear");

const strip = (width, ink) => Bitmap.create(width, STRIP, ink);

const compose = (left, right) => {
  const out = Bitmap.create(
    left.width + GAP + right.width,
    STRIP + Math.max(left.height, right.height),
    BACKGROUND,
  );
  out.paste(strip(left.width, REF_INK), 0, 0);
  out.paste(strip(right.width, GAME_INK), left.width + GAP, 0);
  out.paste(left, 0, STRIP);
  out.paste(right, left.width + GAP, STRIP);
  return out;
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["blur", "game", "height", "out", "ref"],
  });
  const out = getString(args, "out");
  if (!out?.endsWith(".png")) {
    failUsage("--out is required and must end in .png");
  }
  const height = getInt(args, "height", 720);
  const blur = getInt(args, "blur", 24);
  if (height < 64 || blur < 2) {
    failUsage("--height must be ≥ 64 and --blur ≥ 2");
  }

  const ref = fitHeight(load(getString(args, "ref"), "ref"), height);
  const game = fitHeight(load(getString(args, "game"), "game"), height);

  const sharp = compose(ref, game);
  sharp.toFile(out);

  const blurred = compose(soften(ref, blur), soften(game, blur));
  const blurOut = out.replace(/\.png$/u, "-blur.png");
  blurred
    .resize(Math.round(blurred.width / 2), Math.round(blurred.height / 2), "bilinear")
    .toFile(blurOut);

  console.log(
    JSON.stringify({ blur: blurOut, game: game.width, height, ref: ref.width, sxs: out }),
  );
});
