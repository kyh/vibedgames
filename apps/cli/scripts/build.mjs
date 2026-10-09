// Bundles the CLI into dist/ with esbuild. Every dependency is inlined, so the
// published package installs nothing but itself: a cold `npx vibedgames` is
// one small download, and no transitive package can print a deprecation
// warning into an agent's terminal. Each command is its own chunk, loaded when
// it runs (src/index.ts). `--watch` rebuilds on every change.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { build, context } from "esbuild";

const packageRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(packageRoot, "dist");

// Inlined CommonJS dependencies call `require` and read `__dirname`; an ES
// module has neither.
const NODE_ESM_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu;

/** The installed package an esbuild input path sits in, or null for this repo's own source. */
const packageDirOf = (input) => {
  const marker = "node_modules/";
  const at = input.lastIndexOf(marker);
  if (at === -1) {
    return null;
  }
  const [scope = "", name = ""] = input.slice(at + marker.length).split("/");
  const packageName = scope.startsWith("@") ? `${scope}/${name}` : scope;
  return path.resolve(packageRoot, input.slice(0, at + marker.length), packageName);
};

const RULE = "=".repeat(72);

/**
 * Inlining a package copies it, so its licence travels with the bundle: one
 * section per bundled package, with the licence text it ships. Plain text,
 * because licences bring markup of their own.
 */
const writeNotices = async (metafile) => {
  const dirs = [...new Set(Object.keys(metafile.inputs).map(packageDirOf))].filter(Boolean);
  const sections = dirs
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
      const texts = readdirSync(dir)
        .filter((file) => LICENSE_FILE.test(file))
        .toSorted()
        .map((file) => readFileSync(path.join(dir, file), "utf-8").trim());
      const body =
        texts.length > 0
          ? texts.join("\n\n")
          : `Licensed ${manifest.license}; the package ships no licence file.`;
      return `${RULE}\n${manifest.name}@${manifest.version} (${manifest.license})\n${RULE}\n\n${body}\n`;
    })
    .toSorted();
  await writeFile(
    path.join(distDir, "THIRD_PARTY_NOTICES.txt"),
    `The vg CLI bundles the packages below; each one's licence follows its name.\n\n${sections.join("\n")}`,
  );
};

const finishBuild = {
  name: "finish-build",
  setup: (pluginBuild) => {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length > 0 || !result.metafile) {
        return;
      }
      await chmod(path.join(distDir, "index.js"), 0o755);
      await writeNotices(result.metafile);
    });
  },
};

const options = {
  absWorkingDir: packageRoot,
  banner: { js: NODE_ESM_BANNER },
  bundle: true,
  // Flat beside index.js: whatever a chunk resolves against `import.meta.url`
  // must land in dist/, as it does for the entry.
  chunkNames: "chunk-[hash]",
  entryNames: "[name]",
  entryPoints: { index: "src/index.ts" },
  format: "esm",
  logLevel: "info",
  metafile: true,
  outdir: distDir,
  platform: "node",
  plugins: [finishBuild],
  splitting: true,
  target: "node20",
};

await rm(distDir, { force: true, recursive: true });

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  if (!existsSync(path.join(distDir, "index.js"))) {
    throw new Error("esbuild wrote no dist/index.js");
  }
}
