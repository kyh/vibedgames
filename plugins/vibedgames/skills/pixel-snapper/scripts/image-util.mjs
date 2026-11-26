#!/usr/bin/env node
// @ts-check
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

const parseSize = (text = "") => {
  const match = /^(?<w>\d+)\s*x\s*(?<h>\d+)$/iu.exec(text.trim());

  if (!match) {
    failUsage(`--size must be WxH, e.g. 128x128 (got "${text}")`);
  }

  const width = Number(match?.groups?.w);
  const height = Number(match?.groups?.h);

  if (width < 1 || height < 1) {
    failUsage(`--size must be at least 1x1 (got "${text}")`);
  }

  return { height, width };
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["factor", "size"],
  });

  const resize = () => {
    const [, input = "", output = ""] = args.positionals;

    if (input === "" || output === "") {
      failUsage("Usage: node image-util.mjs resize <in.png> <out.png> --size WxH");
    }

    const spec = getString(args, "size") ?? "";

    if (spec === "") {
      failUsage("--size is required, e.g. --size 128x128");
    }

    const { width, height } = parseSize(spec);
    Bitmap.fromFile(input).resize(width, height, "lanczos").toFile(output);
    console.log(`${input} -> ${output} (${width}x${height}, lanczos)`);
  };

  const size = () => {
    const paths = args.positionals.slice(1);

    if (paths.length === 0) {
      failUsage("Usage: node image-util.mjs size <file.png> [...]");
    }

    for (const path of paths) {
      const dims = readImageSize(path) ?? fail(`could not read image dimensions: ${path}`);

      console.log(
        paths.length === 1
          ? `${dims.width}x${dims.height}`
          : `${dims.width}x${dims.height}\t${path}`,
      );
    }
  };

  const upscale = () => {
    const [, input = "", output = ""] = args.positionals;

    if (input === "" || output === "") {
      failUsage("Usage: node image-util.mjs upscale <in.png> <out.png> --factor 8");
    }

    const factor = getInt(args, "factor", 8);

    if (!Number.isInteger(factor) || factor < 1) {
      fail("--factor must be a positive integer");
    }

    const image = Bitmap.fromFile(input);
    image.resize(image.width * factor, image.height * factor, "nearest").toFile(output);
    console.log(
      `${input} -> ${output} (${image.width * factor}x${image.height * factor}, x${factor} nearest)`,
    );
  };

  const run = new Map([
    ["resize", resize],
    ["size", size],
    ["upscale", upscale],
  ]).get(args.positionals[0] ?? "");

  if (run === undefined) {
    failUsage("Usage: node image-util.mjs <size|upscale|resize> ...");
  }

  run?.();
});
