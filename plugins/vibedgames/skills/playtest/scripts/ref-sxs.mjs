#!/usr/bin/env node
// @ts-check
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
