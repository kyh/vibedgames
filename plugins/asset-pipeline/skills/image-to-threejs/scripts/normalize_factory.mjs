#!/usr/bin/env node
/**
 * Make an img2threejs factory shippable in this repo.
 *
 * Raw generator output is not: a quarter of it is spec JSON written onto every
 * node's `userData`, which reaches the browser, and its internals assume a
 * looser tsconfig than ours. This strips the provenance and marks the file
 * generated so the typed import site stays the place safety is enforced.
 *
 * Idempotent — re-run after every regeneration.
 *
 *   node normalize_factory.mjs src/model/chest-factory.generated.ts
 *   node normalize_factory.mjs src/model/*.generated.ts --keep-action-profile
 *   node normalize_factory.mjs --selftest
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getFlag, MARKER, normalizeFactory, parseArgs } from "./_lib/asset-tools.mjs";

/** Python's `f"{x:.1f}"`, which rounds half to even. */
function oneDecimal(value) {
  const scaled = value * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return (rounded / 10).toFixed(1);
}

function selftest() {
  const sample =
    "import * as THREE from 'three';\n" +
    '  node_a.userData.sculptComponent = {"id": "a", "big": "payload"};\n' +
    '  node_a.userData.actionProfile = {"pivot": {}};\n' +
    "  node_a.name = 'keep me';\n";

  const once = normalizeFactory(sample);
  const assert = (condition, message) => {
    if (!condition) {
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  };

  assert(!once.includes("sculptComponent"), "sculptComponent survived");
  assert(!once.includes("actionProfile"), "actionProfile survived");
  assert(once.includes("keep me"), "dropped an unrelated line");
  assert(once.startsWith(MARKER), "missing generated marker");
  assert(normalizeFactory(once) === once, "not idempotent");

  const kept = normalizeFactory(sample, true);
  assert(kept.includes("actionProfile"), "--keep-action-profile did not keep it");
  assert(!kept.includes("sculptComponent"), "sculptComponent survived");

  console.log("selftest ok");
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2), {
  booleans: ["keep-action-profile", "selftest"],
});
if (getFlag(args, "selftest")) selftest();

const files = args.positionals;
if (files.length === 0) {
  process.stderr.write("pass at least one generated factory, or --selftest\n");
  process.exit(2);
}

const keepActionProfile = getFlag(args, "keep-action-profile");
let failed = false;

for (const path of files) {
  if (!existsSync(path)) {
    process.stderr.write(`missing: ${path}\n`);
    failed = true;
    continue;
  }
  const before = readFileSync(path, "utf8");
  const after = normalizeFactory(before, keepActionProfile);
  writeFileSync(path, after);

  const saved = before.length - after.length;
  const pct = before.length ? (100 * saved) / before.length : 0;
  console.log(
    `normalized ${path}: ${oneDecimal(before.length / 1024)}KB -> ${oneDecimal(after.length / 1024)}KB (-${oneDecimal(pct)}%)`,
  );
}

process.exit(failed ? 1 : 0);
