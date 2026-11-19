import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const packageRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(packageRoot, "dist", "npm", "factory");

const readJson = async (file) => JSON.parse(await readFile(file, "utf-8"));

const manifest = await readJson(path.join(packageRoot, "package.json"));

const dependencies = Object.fromEntries(
  await Promise.all(
    Object.keys(manifest.dependencies).map(async (name) => {
      const installed = await readJson(
        path.join(packageRoot, "node_modules", name, "package.json"),
      );

      return [name, `^${installed.version}`];
    }),
  ),
);

await rm(outDir, { force: true, recursive: true });

await build({
  absWorkingDir: packageRoot,
  bundle: true,
  entryPoints: ["src/index.ts"],
  format: "esm",
  jsx: "automatic",
  logLevel: "info",
  outfile: path.join(outDir, "bin", "vg-factory.js"),
  packages: "external",
  platform: "node",
  target: "node22",
});

await cp(path.join(packageRoot, "agents"), path.join(outDir, "agents"), { recursive: true });

await writeFile(
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      bin: { "vg-factory": "bin/vg-factory.js" },
      dependencies,
      description: "vibedgames factory — an autonomous agent that builds and runs browser games",
      engines: manifest.engines,
      files: ["bin", "agents"],
      name: "@vibedgames/factory",
      publishConfig: { access: "public" },
      type: "module",
      version: manifest.version,
    },
    null,
    2,
  )}\n`,
);

console.log(`Staged @vibedgames/factory@${manifest.version} in ${outDir}`);
