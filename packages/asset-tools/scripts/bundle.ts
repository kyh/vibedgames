#!/usr/bin/env tsx
/**
 * Bundle this package into a dependency-free `_lib/asset-tools.mjs` inside
 * every skill whose scripts need it.
 *
 * Skills are installed one directory at a time (`skills add` copies each one),
 * so a script cannot import across skill boundaries and a skill cannot rely on
 * a `node_modules` being present. Each skill therefore gets its own bundled
 * copy, generated from this single source and committed alongside the scripts
 * — the same reasoning that makes `.claude/skills/` symlinks committed.
 *
 * Run via `pnpm --filter @repo/asset-tools build`, which `pnpm dogfood` calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

/** Skills whose scripts import the shared library. */
const CONSUMERS = [
  "asset-pipeline/skills/asset-pipeline",
  "asset-pipeline/skills/animated-spritesheets",
  "asset-pipeline/skills/pixel-snapper",
  "asset-pipeline/skills/image-to-threejs",
  "asset-pipeline/skills/aseprite",
  "tooling/skills/playwright",
];

const BANNER = `// GENERATED FILE — do not edit.
// Built from packages/asset-tools by \`pnpm --filter @repo/asset-tools build\`.
// Edit the TypeScript source there and re-run \`pnpm dogfood\` (or that build)
// to regenerate every skill's copy.`;

const result = await build({
  entryPoints: [join(PACKAGE_ROOT, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  // Node 22 is the floor the CLI already assumes; targeting it keeps the
  // output readable rather than down-levelling modern syntax.
  target: "node22",
  banner: { js: BANNER },
  write: false,
  legalComments: "none",
});

const output = result.outputFiles?.[0];
if (!output) throw new Error("esbuild produced no output");

for (const consumer of CONSUMERS) {
  const dir = join(REPO_ROOT, "plugins", consumer, "scripts", "_lib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "asset-tools.mjs"), output.text);
  console.log(`→ ${consumer}/scripts/_lib/asset-tools.mjs`);
}

const kb = (output.text.length / 1024).toFixed(1);
console.log(`bundled ${CONSUMERS.length} copies (${kb} kB each, zero dependencies)`);
