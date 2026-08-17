#!/usr/bin/env node
/**
 * Small image utilities so the snapper workflow needs no ffmpeg, ImageMagick
 * or `sips`.
 *
 * Subcommands:
 *   size <png...>                    print WIDTHxHEIGHT per file
 *   upscale <in> <out> --factor 8    integer nearest-neighbour upscale
 *   resize  <in> <out> --size WxH    smooth (Lanczos) resize
 *
 * `upscale` is the one to reach for when eyeballing a snapped sprite: nearest
 * neighbour at an integer factor keeps every pixel a hard square, so you are
 * judging the actual recovered art rather than a resampler's smoothing.
 */
import {
  Bitmap,
  fail,
  failUsage,
  getInt,
  getString,
  main,
  parseArgs,
  readImageSize,
} from "./_lib/asset-tools.mjs";

function parseSize(text) {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim());
  if (!match) failUsage(`--size must be WxH, e.g. 128x128 (got "${text}")`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  // `--size 0x8` resized without complaint and wrote a zero-width PNG, which
  // every later step then read as a valid image.
  if (width < 1 || height < 1) {
    failUsage(`--size must be at least 1x1 (got "${text}")`);
  }
  return { width, height };
}

const COMMANDS = {
  size(args) {
    const paths = args.positionals.slice(1);
    if (paths.length === 0) failUsage("Usage: node image-util.mjs size <file.png> [...]");
    for (const path of paths) {
      const size = readImageSize(path);
      if (!size) fail(`could not read image dimensions: ${path}`);
      console.log(
        paths.length === 1
          ? `${size.width}x${size.height}`
          : `${size.width}x${size.height}\t${path}`,
      );
    }
  },

  upscale(args) {
    const [, input, output] = args.positionals;
    if (!input || !output) {
      failUsage("Usage: node image-util.mjs upscale <in.png> <out.png> --factor 8");
    }
    const factor = getInt(args, "factor", 8);
    if (!Number.isInteger(factor) || factor < 1) fail("--factor must be a positive integer");

    const image = Bitmap.fromFile(input);
    image.resize(image.width * factor, image.height * factor, "nearest").toFile(output);
    console.log(
      `${input} -> ${output} (${image.width * factor}x${image.height * factor}, x${factor} nearest)`,
    );
  },

  resize(args) {
    const [, input, output] = args.positionals;
    if (!input || !output) {
      failUsage("Usage: node image-util.mjs resize <in.png> <out.png> --size WxH");
    }
    const spec = getString(args, "size");
    if (!spec) failUsage("--size is required, e.g. --size 128x128");
    const { width, height } = parseSize(spec);

    Bitmap.fromFile(input).resize(width, height, "lanczos").toFile(output);
    console.log(`${input} -> ${output} (${width}x${height}, lanczos)`);
  },
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["factor", "size"],
  });
  const run = COMMANDS[args.positionals[0]];
  if (!run) failUsage("Usage: node image-util.mjs <size|upscale|resize> ...");
  run(args);
});
