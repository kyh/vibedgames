import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import {
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
  },
  run: async ({ args }) => {
    const dir = resolve(args.dir);

    if (!existsSync(dir)) {
      consola.error(`Directory does not exist: ${dir}`);
      process.exit(1);
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
    const manifest = buildManifest(dir);
    if (manifest.length === 0) {
      consola.error(`No files found in ${dir}`);
      process.exit(1);
    }

    const hasIndex = manifest.some((f) => f.path === "index.html");
    if (!hasIndex) {
      consola.error("Deployment must contain an index.html at the root.");
      process.exit(1);
    }

    const totalBytes = manifest.reduce((acc, f) => acc + f.size, 0);
    consola.info(
      `Deploying ${config.slug}: ${manifest.length} files, ${formatBytes(totalBytes)}`,
    );

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
      });
    } catch (err) {
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
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
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
