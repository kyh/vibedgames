#!/usr/bin/env node
/**
 * Aseprite inspector: parse .ase/.aseprite structure and (optionally) infer
 * pixel/tile-derived facts.
 *
 * Goals:
 * - Safe: chunk-driven parsing; unknown chunks are skipped by size.
 * - Useful: emits JSON describing header/frames/layers/cels/tags/slices/
 *   tilesets/palettes/userdata.
 * - Optional inference: --decode-cels to zlib-decompress cel/tilemap data and
 *   compute tight bounds.
 *
 *   node aseprite_inspect.mjs sprite.aseprite --json
 *   node aseprite_inspect.mjs sprite.aseprite --pretty --decode-cels
 */
import { readFileSync } from "node:fs";

import { getFlag, getNumber, inspectAseprite, main, parseArgs } from "./_lib/asset-tools.mjs";

const USAGE = `usage: aseprite_inspect.mjs [-h] [--json] [--pretty] [--decode-cels]
                            [--max-decompress-mib MAX_DECOMPRESS_MIB]
                            [--palette-entries PALETTE_ENTRIES]
                            [--treat-index0-transparent]
                            file

Inspect an Aseprite .ase/.aseprite file and emit JSON.

positional arguments:
  file                  Path to .ase/.aseprite (sometimes typo .aes).

options:
  --json                Emit JSON to stdout (default).
  --pretty              Pretty-print JSON.
  --decode-cels         Zlib-decompress cel/tilemap data for extra inference
                        (bounds/summaries).
  --max-decompress-mib MAX_DECOMPRESS_MIB
                        Safety limit for decompressed bytes (MiB). Default 64.
  --palette-entries PALETTE_ENTRIES
                        How many palette entries to include per palette chunk
                        preview. Default 16.
  --treat-index0-transparent
                        For indexed sprites, also treat palette index 0 as
                        transparent when inferring bounds (heuristic; off by
                        default).`;

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["max-decompress-mib", "palette-entries"],
    // `json` is accepted and ignored — JSON is the only output — but it still
    // has to be declared, or `--json file.ase` would eat the filename.
    booleans: ["decode-cels", "help", "json", "pretty", "treat-index0-transparent"],
  });

  if (getFlag(args, "help")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const file = args.positionals[0];
  if (file === undefined) {
    process.stderr.write(`${USAGE}\n\nerror: the following arguments are required: file\n`);
    process.exit(2);
  }

  const report = inspectAseprite(file, readFileSync(file), {
    decodeCels: getFlag(args, "decode-cels"),
    maxDecompressMib: getNumber(args, "max-decompress-mib", 64),
    paletteEntries: getNumber(args, "palette-entries", 16),
    treatIndex0Transparent: getFlag(args, "treat-index0-transparent"),
  });

  const json = getFlag(args, "pretty") ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  process.stdout.write(`${json}\n`);
});
