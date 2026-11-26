#!/usr/bin/env node
// @ts-check
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getFlag, MARKER, normalizeFactory, parseArgs } from "./_lib/asset-tools.mjs";

const oneDecimal = (value = 0) => {
  const scaled = value * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded = floor;

  if (diff > 0.5 || (diff === 0.5 && floor % 2 !== 0)) {
    rounded = floor + 1;
  }

  return (rounded / 10).toFixed(1);
};

const assert = (condition = false, message = "") => {
  if (!condition) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
};

const selftest = () => {
  const sample =
    "import * as THREE from 'three';\n" +
    '  node_a.userData.sculptComponent = {"id": "a", "big": "payload"};\n' +
    '  node_a.userData.actionProfile = {"pivot": {}};\n' +
    "  node_a.name = 'keep me';\n";

  const once = normalizeFactory(sample);

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
};

const args = parseArgs(process.argv.slice(2), {
  booleans: ["keep-action-profile", "selftest"],
});

if (getFlag(args, "selftest")) {
  selftest();
}

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

  const before = readFileSync(path, "utf-8");
  const after = normalizeFactory(before, keepActionProfile);
  writeFileSync(path, after);

  const saved = before.length - after.length;
  const pct = before.length ? (100 * saved) / before.length : 0;
  console.log(
    `normalized ${path}: ${oneDecimal(before.length / 1024)}KB -> ${oneDecimal(after.length / 1024)}KB (-${oneDecimal(pct)}%)`,
  );
}

process.exit(failed ? 1 : 0);
