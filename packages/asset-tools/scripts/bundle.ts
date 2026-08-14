#!/usr/bin/env tsx
/**
 * Bundle this package into a dependency-free `_lib/asset-tools.mjs` inside
 * every skill whose scripts need it.
 *
 * Skills are installed and copied one directory at a time, so a script cannot
 * import across skill boundaries and cannot rely on a `node_modules` being
 * present. Each skill therefore gets its own copy, generated from this single
 * source and committed alongside the scripts — the same reasoning that makes
 * `.claude/skills/` symlinks committed.
 *
 * The copies are not identical: each skill's entry point is derived from the
 * names its own scripts import, so esbuild tree-shakes away everything else.
 * `skill-creator` never touches a pixel and does not carry the PNG codec;
 * `image-to-threejs` does string surgery and carries almost nothing. A skill
 * that grows an import gets it on the next build.
 *
 * Run via `pnpm --filter @repo/asset-tools build`, which `pnpm dogfood` calls.
 */
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "tooling/skills/skill-creator",
];

const BANNER = `// GENERATED FILE — do not edit.
// Built from packages/asset-tools by \`pnpm --filter @repo/asset-tools build\`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run \`pnpm dogfood\` (or that build) to regenerate.`;

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"\.\/_lib\/asset-tools\.mjs"/gs;

/** The names a skill's scripts actually pull out of the library. */
function importedNames(scriptsDir: string): string[] {
  const names = new Set<string>();
  for (const file of globSync("*.mjs", { cwd: scriptsDir })) {
    const source = readFileSync(join(scriptsDir, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      for (const clause of match[1]!.split(",")) {
        // `a as b` imports `a`; the local alias is the script's business.
        const name = clause
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort();
}

let total = 0;
for (const consumer of CONSUMERS) {
  const scriptsDir = join(REPO_ROOT, "plugins", consumer, "scripts");
  const names = importedNames(scriptsDir);
  if (names.length === 0) {
    throw new Error(`${consumer} is listed as a consumer but imports nothing from the library`);
  }

  const result = await build({
    stdin: {
      contents: `export { ${names.join(", ")} } from "./src/index.ts";`,
      resolveDir: PACKAGE_ROOT,
      sourcefile: `${consumer}-entry.ts`,
      loader: "ts",
    },
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
  if (!output) throw new Error(`esbuild produced no output for ${consumer}`);

  const dir = join(scriptsDir, "_lib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "asset-tools.mjs"), output.text);
  total += output.text.length;

  const kb = (output.text.length / 1024).toFixed(1).padStart(6);
  console.log(`${kb} kB  ${String(names.length).padStart(2)} exports  ${consumer}`);
}

console.log(
  `\n${CONSUMERS.length} bundles, ${(total / 1024).toFixed(1)} kB total, zero dependencies`,
);
