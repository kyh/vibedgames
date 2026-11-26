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
  parseColor,
} from "./_lib/asset-tools.mjs";

const GAP = 8;
const STRIP = 6;
const BACKGROUND = parseColor("#101010");
const REF_INK = parseColor("#dc3c3c");
const GAME_INK = parseColor("#3cc85a");

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["blur", "game", "height", "out", "ref"],
  });

  const out = getString(args, "out") ?? "";

  if (!out.endsWith(".png")) {
    failUsage("--out is required and must end in .png");
  }

  const height = getInt(args, "height", 720);
  const blur = getInt(args, "blur", 24);

  if (height < 64 || blur < 2) {
    failUsage("--height must be ≥ 64 and --blur ≥ 2");
  }

  const sides = [
    { ink: REF_INK, role: "ref" },
    { ink: GAME_INK, role: "game" },
  ].map(({ ink, role }) => {
    const file = getString(args, role) ?? "";

    if (file === "") {
      failUsage(`--${role} is required (a PNG path)`);
    }

    if (!existsSync(file)) {
      fail(`${role} not found: ${file}`);
    }

    const image = Bitmap.fromFile(file).flatten([0, 0, 0]);

    const sharp = image.resize(
      Math.max(1, Math.round((image.width * height) / image.height)),
      height,
      "bilinear",
    );

    const soft = sharp
      .resize(
        Math.max(1, Math.round(sharp.width / blur)),
        Math.max(1, Math.round(sharp.height / blur)),
        "bilinear",
      )
      .resize(sharp.width, sharp.height, "bilinear");

    return { ink, sharp, soft };
  });

  const compose = (images = sides.map((side) => side.sharp)) => {
    const composed = Bitmap.create(
      images.reduce((width, image) => width + image.width, 0) + GAP * (images.length - 1),
      STRIP + Math.max(...images.map((image) => image.height)),
      BACKGROUND,
    );

    let x = 0;

    for (const [i, image] of images.entries()) {
      composed.paste(Bitmap.create(image.width, STRIP, sides[i]?.ink ?? BACKGROUND), x, 0);
      composed.paste(image, x, STRIP);
      x += image.width + GAP;
    }

    return composed;
  };

  const [ref, game] = sides.map((side) => side.sharp);

  compose().toFile(out);

  const blurred = compose(sides.map((side) => side.soft));
  const blurOut = out.replace(/\.png$/u, "-blur.png");
  blurred
    .resize(Math.round(blurred.width / 2), Math.round(blurred.height / 2), "bilinear")
    .toFile(blurOut);

  console.log(
    JSON.stringify({ blur: blurOut, game: game?.width, height, ref: ref?.width, sxs: out }),
  );
});
