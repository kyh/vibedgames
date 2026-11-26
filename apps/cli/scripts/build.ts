import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BuildOptions, Metafile, Plugin } from "esbuild";
import { build, context } from "esbuild";
import { z } from "zod";

const packageRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(packageRoot, "dist");

const NODE_ESM_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu;

const packageDirOf = (input: string) => {
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

const packageManifest = z.object({
  license: z.string().optional(),
  name: z.string(),
  version: z.string(),
});

const writeNotices = async (metafile: Metafile) => {
  const dirs = [...new Set(Object.keys(metafile.inputs).map(packageDirOf))].filter(
    (dir) => dir !== null,
  );

  const sections = dirs
    .map((dir) => {
      const manifest = packageManifest.parse(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")),
      );

      const texts = readdirSync(dir)
        .filter((file) => LICENSE_FILE.test(file))
        .toSorted()
        .map((file) => readFileSync(path.join(dir, file), "utf-8").trim());

      const body =
        texts.length > 0
          ? texts.join("\n\n")
          : `Licensed ${manifest.license ?? "with no licence named"}; the package ships no licence file.`;

      return `${RULE}\n${manifest.name}@${manifest.version} (${manifest.license ?? "unlicensed"})\n${RULE}\n\n${body}\n`;
    })
    .toSorted();

  await writeFile(
    path.join(distDir, "THIRD_PARTY_NOTICES.txt"),
    `The vg CLI bundles the packages below; each one's licence follows its name.\n\n${sections.join("\n")}`,
  );
};

const finishBuild: Plugin = {
  name: "finish-build",
  setup: (pluginBuild) => {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length > 0 || result.metafile === undefined) {
        return;
      }

      await chmod(path.join(distDir, "index.js"), 0o755);
      await writeNotices(result.metafile);
    });
  },
};

const options: BuildOptions = {
  absWorkingDir: packageRoot,
  banner: { js: NODE_ESM_BANNER },
  bundle: true,
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
