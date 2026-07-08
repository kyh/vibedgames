import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import { packSource, type SourceArchive } from "../lib/archive.js";
import {
  findProjectRoot,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "../lib/config-file.js";
import { buildManifest } from "../lib/manifest.js";
import { uploadAll } from "../lib/upload.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy a game to vibedgames",
  },
  args: {
    dir: {
      type: "positional",
      description: "Directory to deploy",
      required: false,
      default: ".",
    },
    slug: {
      type: "string",
      description: "Override the slug (bypasses vibedgames.json)",
      required: false,
    },
    source: {
      type: "boolean",
      description:
        "Upload a forkable source archive alongside the build (use --no-source to skip).",
      default: true,
    },
  },
  run: async ({ args }) => {
    const dir = resolve(args.dir);

    if (!existsSync(dir)) {
      consola.error(`Directory does not exist: ${dir}`);
      process.exit(1);
    }

    // Build-tool projects (package.json present): the root index.html is the
    // source template, the playable game lives in the build output. Deploying
    // the root uploads the whole source tree — wrong content and usually over
    // the file caps — so prefer a build directory when one exists. Checked in
    // popularity order: Vite/Rollup/Parcel → CRA/Preact → Next export/esbuild.
    let deployDir = dir;
    if (existsSync(join(dir, "package.json"))) {
      for (const name of ["dist", "build", "out"]) {
        if (existsSync(join(dir, name, "index.html"))) {
          deployDir = join(dir, name);
          consola.info(`Project root detected — deploying its build output ${name}/ instead.`);
          break;
        }
      }
      if (deployDir === dir) {
        consola.warn(
          "This looks like an unbuilt project (package.json, no dist/build/out) — " +
            "run the build first, or the deployed index.html will reference missing source files.",
        );
      }
    }

    // ---- Resolve project config ---------------------------------------------
    let config: ProjectConfig | null = null;
    try {
      config = readProjectConfig(dir);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (args.slug) {
      config = { slug: args.slug, name: config?.name };
    }

    if (!config) {
      if (!process.stdin.isTTY) {
        consola.error(
          "No slug specified and no vibedgames.json found.\n" +
            "  Pass --slug <name> when running without a TTY (e.g. in CI or from a coding agent).\n" +
            "  Example: vg deploy ./dist --slug my-game",
        );
        process.exit(1);
      }
      const slug = await consola.prompt("Slug (e.g. pong):", { type: "text" });
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
        consola.error("Invalid slug. Use lowercase letters, digits, hyphens.");
        process.exit(1);
      }
      const name = await consola.prompt("Name (optional):", { type: "text" });
      config = {
        slug,
        name: typeof name === "string" && name.length > 0 ? name : undefined,
      };
      writeProjectConfig(dir, config);
      consola.info(`Wrote ${projectConfigPath(dir)}`);
    }

    if (!SLUG_RE.test(config.slug)) {
      consola.error(`Invalid slug in vibedgames.json: ${config.slug}`);
      process.exit(1);
    }

    // ---- Walk files ---------------------------------------------------------
    const manifest = buildManifest(deployDir);
    if (manifest.length === 0) {
      consola.error(`No files found in ${deployDir}`);
      process.exit(1);
    }

    const hasIndex = manifest.some((f) => f.path === "index.html");
    if (!hasIndex) {
      consola.error("Deployment must contain an index.html at the root.");
      process.exit(1);
    }

    const totalBytes = manifest.reduce((acc, f) => acc + f.size, 0);
    consola.info(`Deploying ${config.slug}: ${manifest.length} files, ${formatBytes(totalBytes)}`);

    // ---- Pack forkable source (default on; --no-source to skip) -------------
    let sourceArchive: SourceArchive | null = null;
    if (args.source) {
      const root = findProjectRoot(dir);
      if (!root) {
        consola.warn("No vibedgames.json found above the deploy dir — skipping source upload.");
      } else {
        try {
          sourceArchive = await packSource(root, join(tmpdir(), "vibedgames"));
          consola.info(
            `Source: ${sourceArchive.files.length} files, ${formatBytes(sourceArchive.bytes)} — forkable via \`vg fork ${config.slug}\``,
          );
        } catch (err) {
          consola.error(
            `Source archive failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      }
    }

    // ---- Create deployment --------------------------------------------------
    const client = createClient();
    const started = Date.now();

    let created;
    try {
      created = await client.deploy.create.mutate({
        slug: config.slug,
        name: config.name,
        files: manifest.map((f) => ({
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          contentType: f.contentType,
        })),
        source: sourceArchive
          ? { sha256: sourceArchive.sha256, bytes: sourceArchive.bytes }
          : undefined,
      });
    } catch (err) {
      if (sourceArchive) rmSync(sourceArchive.path, { force: true });
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // ---- Upload to R2 -------------------------------------------------------
    consola.start(`Uploading ${created.uploads.length} files`);
    try {
      await uploadAll({
        files: manifest,
        uploads: created.uploads,
        onProgress: (done, total) => {
          if (done === total || done % 10 === 0) {
            consola.info(`Uploaded ${done}/${total}`);
          }
        },
      });
    } catch (err) {
      if (sourceArchive) rmSync(sourceArchive.path, { force: true });
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // ---- Upload source archive (best-effort companion to the bundle) -------
    if (sourceArchive && created.sourceUpload) {
      try {
        const res = await fetch(created.sourceUpload.url, {
          method: "PUT",
          headers: created.sourceUpload.headers,
          body: readFileSync(sourceArchive.path),
        });
        if (!res.ok) {
          throw new Error(`source upload failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        rmSync(sourceArchive.path, { force: true });
        consola.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      rmSync(sourceArchive.path, { force: true });
    } else if (sourceArchive) {
      rmSync(sourceArchive.path, { force: true });
    }

    // ---- Finalize -----------------------------------------------------------
    let finalized;
    try {
      finalized = await client.deploy.finalize.mutate({
        deploymentId: created.deploymentId,
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    consola.success(`Deployed ${config.slug} in ${elapsed}s`);
    consola.log(`  ${finalized.url}`);
  },
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
