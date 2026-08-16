#!/usr/bin/env node
/**
 * Analyze sprite-sheet grids and list non-empty frames.
 *
 * Examples:
 *   node asset_sheet_probe.mjs path/to/sheet.png --frame 32x32 --list
 *   node asset_sheet_probe.mjs path/to/folder --frame 16x16 --list --json tmp/probe.json
 */
import {
  fail,
  failUsage,
  getFlag,
  getString,
  main,
  parseArgs,
  parseFrame,
  probeSheet,
  resolveTargets,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["frame", "json"],
    booleans: ["list", "show-empty"],
  });
  const target = args.positionals[0];
  if (!target) failUsage("A PNG file or folder path is required.");

  const frameSpec = getString(args, "frame");
  if (!frameSpec) failUsage("--frame is required, e.g. --frame 32x32");
  const frame = parseFrame(frameSpec);
  const showEmpty = getFlag(args, "show-empty");

  const results = resolveTargets(target).map((path) => probeSheet(path, frame, showEmpty));
  const format = (pairs) => `[${pairs.map(([c, r]) => `(${c}, ${r})`).join(", ")}]`;

  for (const result of results) {
    console.log(
      `${result.path}  grid=${result.grid.columns}x${result.grid.rows}` +
        `  non_empty=${result.non_empty.length}  empty=${result.empty_count}`,
    );
    if (getFlag(args, "list")) console.log(`  non_empty=${format(result.non_empty)}`);
    if (showEmpty) console.log(`  empty=${format(result.empty ?? [])}`);
  }

  const json = getString(args, "json");
  if (json) writeJsonFile(json, results);
});
