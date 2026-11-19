#!/usr/bin/env tsx
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

const BANNER = `// GENERATED FILE — do not edit.
// Built from packages/asset-tools by \`pnpm --filter @repo/asset-tools build\`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run \`pnpm dogfood\` (or that build) to regenerate.`;

const IMPORT_RE = /import\s*\{(?<names>[^}]*)\}\s*from\s*"\.\/_lib\/asset-tools\.mjs"/gsu;

const importedNames = (scriptsDir: string) => {
  const names = new Set<string>();

  for (const file of globSync("*.mjs", { cwd: scriptsDir })) {
    const source = readFileSync(path.join(scriptsDir, file), "utf-8");

    for (const match of source.matchAll(IMPORT_RE)) {
      for (const clause of (match.groups?.names ?? "").split(",")) {
        const name = clause
          .trim()
          .split(/\s+as\s+/u)[0]
          ?.trim();

        if (name) {
          names.add(name);
        }
      }
    }
  }

  return [...names].toSorted();
};

const findConsumers = () => {
  const dirs = new Set<string>();

  for (const file of globSync("*/skills/*/scripts/*.mjs", { cwd: PLUGINS_ROOT })) {
    const scriptsDir = path.join(PLUGINS_ROOT, path.dirname(file));

    if (importedNames(scriptsDir).length > 0) {
      dirs.add(path.dirname(path.dirname(file)));
    }
  }

  return [...dirs].toSorted();
};

const pruneOrphans = (consumers: Set<string>) => {
  for (const file of globSync("*/skills/*/scripts/_lib/asset-tools.mjs", { cwd: PLUGINS_ROOT })) {
    const skill = path.dirname(path.dirname(path.dirname(file)));

    if (consumers.has(skill)) {
      continue;
    }

    rmSync(path.join(PLUGINS_ROOT, path.dirname(file)), { force: true, recursive: true });
    console.log(`  pruned  ${skill} (no script imports the library)`);
  }
};

const CONSUMERS = findConsumers();

if (CONSUMERS.length === 0) {
  throw new Error("no skill imports the library — is the glob wrong?");
}

pruneOrphans(new Set(CONSUMERS));

let total = 0;

for (const consumer of CONSUMERS) {
  const scriptsDir = path.join(PLUGINS_ROOT, consumer, "scripts");
  const names = importedNames(scriptsDir);

  const result = await build({
    banner: { js: BANNER },
    bundle: true,
    format: "esm",
    legalComments: "none",
    platform: "node",
    stdin: {
      contents: `export { ${names.join(", ")} } from "./src/index.ts";`,
      loader: "ts",
      resolveDir: PACKAGE_ROOT,
      sourcefile: `${consumer}-entry.ts`,
    },
    target: "node22",
    write: false,
  });

  const output = result.outputFiles?.[0];

  if (!output) {
    throw new Error(`esbuild produced no output for ${consumer}`);
  }

  const dir = path.join(scriptsDir, "_lib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "asset-tools.mjs"), output.text);
  total += output.text.length;

  const kb = (output.text.length / 1024).toFixed(1).padStart(6);
  console.log(`${kb} kB  ${String(names.length).padStart(2)} exports  ${consumer}`);
}

console.log(
  `\n${CONSUMERS.length} bundles, ${(total / 1024).toFixed(1)} kB total, zero dependencies`,
);
