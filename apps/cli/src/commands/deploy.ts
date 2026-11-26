import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { MAX_UPLOAD_BODY } from "@repo/contract/deploy/deploy-schema";

import { createClient } from "../lib/api.js";
import { packBuild, packSource } from "../lib/archive.js";
import { resolveBuildDir } from "../lib/build-dir.js";
import {
  findProjectRoot,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
  SLUG_RE,
} from "../lib/config-file.js";
import type { ProjectConfig } from "../lib/config-file.js";
import { buildManifest } from "../lib/manifest.js";
import { isJsonOutput, outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { isJsonString } from "../lib/types.js";
import { uploadAll } from "../lib/upload.js";

const deployArgs = {
  dir: {
    default: ".",
    description: "Directory to deploy",
    required: false,
    type: "positional",
  },
  slug: {
    description: "Override the slug (bypasses vibedgames.json)",
    required: false,
    type: "string",
  },
  source: {
    default: false,
    description:
      "Also upload a forkable source archive, letting anyone logged in fork the project.",
    type: "boolean",
  },
  ...outputArgs,
} as const;

const formatBytes = (n: number) => {
  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }

  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

type Say = (message: string) => void;

const resolveDeployDir = (dir: string, say: Say) => {
  const build = resolveBuildDir(dir);

  if (build.kind === "build") {
    say(`Project root detected — deploying its build output ${build.name}/ instead.`);
  } else if (build.kind === "unbuilt") {
    consola.warn(
      "This looks like an unbuilt project (package.json, no dist/build/out) — " +
        "run the build first, or the deployed index.html will reference missing source files.",
    );
  }

  return build.dir;
};

const promptForConfig = async (dir: string, say: Say) => {
  if (!process.stdin.isTTY) {
    consola.error(
      "No slug specified and no vibedgames.json found.\n" +
        "  Pass --slug <name> when running without a TTY (e.g. in CI or from a coding agent).\n" +
        "  Example: vg deploy ./dist --slug my-game",
    );
    process.exit(1);
  }

  const slug = await consola.prompt("Slug (e.g. pong):", { type: "text" });

  if (!isJsonString(slug) || !SLUG_RE.test(slug)) {
    consola.error("Invalid slug. Use lowercase letters, digits, hyphens.");
    process.exit(1);
  }

  const name = await consola.prompt("Name (optional):", { type: "text" });

  const config: ProjectConfig = {
    name: isJsonString(name) && name.length > 0 ? name : undefined,
    slug,
  };

  writeProjectConfig(dir, config);
  say(`Wrote ${projectConfigPath(dir)}`);

  return config;
};

const resolveDeployConfig = async (dir: string, slugOverride: string | undefined, say: Say) => {
  let config: ProjectConfig | null = null;

  try {
    config = readProjectConfig(dir);
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (slugOverride !== undefined && slugOverride !== "") {
    config = { name: config?.name, slug: slugOverride };
  }

  config ??= await promptForConfig(dir, say);

  if (!SLUG_RE.test(config.slug)) {
    consola.error(`Invalid slug in vibedgames.json: ${config.slug}`);
    process.exit(1);
  }

  return config;
};

const packForkableSource = async (dir: string, slug: string, say: Say) => {
  const root = findProjectRoot(dir);

  if (root === null || root === "") {
    consola.warn("No vibedgames.json found above the deploy dir — skipping source upload.");

    return null;
  }

  try {
    const archive = await packSource(root, path.join(tmpdir(), "vibedgames"));
    say(
      `Source: ${archive.files.length} files, ${formatBytes(archive.bytes)} — forkable via \`vg fork ${slug}\``,
    );

    return archive;
  } catch (error) {
    consola.error(
      `Source archive failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};

const putArchive = async (
  archivePath: string,
  upload: { url: string; headers: Record<string, string> },
  what: string,
) => {
  const res = await fetch(upload.url, {
    body: readFileSync(archivePath),
    headers: upload.headers,
    method: "PUT",
  });

  if (!res.ok) {
    throw new Error(`${what} upload failed: ${res.status} ${res.statusText}`);
  }
};

const publishDeployment: (
  client: ReturnType<typeof createClient>,
  { deploymentId, slug }: { deploymentId: string; slug: string },
) => Promise<{ url: string }> = async (client, { deploymentId, slug }) => {
  try {
    const published = await client.deploy.upload({ deploymentId, publish: true, slug });

    if (published.url === null) {
      throw new Error("The deployment did not publish.");
    }

    return { url: published.url };
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

export const deployCommand = defineCommand({
  args: deployArgs,
  meta: {
    description: "Deploy a game to vibedgames",
    name: "deploy",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, deployArgs);

    const structured = isJsonOutput(args) || Boolean(args.field);

    const say = structured
      ? () => null
      : (message: string) => {
          consola.info(message);
        };

    const dir = path.resolve(args.dir);

    if (!existsSync(dir)) {
      consola.error(`Directory does not exist: ${dir}`);
      process.exit(1);
    }

    const deployDir = resolveDeployDir(dir, say);

    const config = await resolveDeployConfig(dir, args.slug, say);

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
    say(`Deploying ${config.slug}: ${manifest.length} files, ${formatBytes(totalBytes)}`);

    const sourceArchive = args.source ? await packForkableSource(dir, config.slug, say) : null;

    const tmp = path.join(tmpdir(), "vibedgames");

    const bundle = await packBuild(
      deployDir,
      manifest.map((f) => f.path),
      tmp,
    );

    const cleanUp = () => {
      rmSync(bundle.path, { force: true });

      if (sourceArchive) {
        rmSync(sourceArchive.path, { force: true });
      }
    };

    const client = createClient();
    const started = Date.now();

    const asBundle = bundle.bytes <= MAX_UPLOAD_BODY;
    let created;

    try {
      created = await client.deploy.upload({
        bundle: asBundle,
        name: config.name,
        presign: asBundle
          ? []
          : manifest.map((f) => ({
              contentType: f.contentType,
              path: f.path,
              sha256: f.sha256,
              size: f.size,
            })),
        slug: config.slug,
        sourceArchive: sourceArchive
          ? { bytes: sourceArchive.bytes, sha256: sourceArchive.sha256 }
          : undefined,
      });

      if (!structured) {
        consola.start(
          asBundle
            ? `Uploading ${formatBytes(bundle.bytes)}`
            : `Uploading ${manifest.length} files (too large for one bundle)`,
        );
      }

      if (asBundle) {
        if (!created.bundleUpload) {
          throw new Error("The server returned no bundle upload URL.");
        }

        await putArchive(bundle.path, created.bundleUpload, "bundle");
      } else {
        await uploadAll({
          files: manifest,
          onProgress: (done, total) => {
            if (done === total || done % 10 === 0) {
              say(`Uploaded ${done}/${total}`);
            }
          },
          uploads: created.uploads,
        });
      }

      if (sourceArchive && created.sourceUpload) {
        await putArchive(sourceArchive.path, created.sourceUpload, "source");
      }
    } catch (error) {
      cleanUp();
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    cleanUp();

    const published = await publishDeployment(client, {
      deploymentId: created.deploymentId,
      slug: config.slug,
    });

    const elapsedMs = Date.now() - started;

    if (
      writeStructured(
        {
          bytes: totalBytes,
          deployment_id: created.deploymentId,
          elapsed_ms: elapsedMs,
          files: manifest.length,
          slug: config.slug,
          source: sourceArchive
            ? { bytes: sourceArchive.bytes, files: sourceArchive.files.length }
            : null,
          url: published.url,
        },
        args,
      )
    ) {
      return;
    }

    consola.success(`Deployed ${config.slug} in ${(elapsedMs / 1000).toFixed(1)}s`);
    consola.log(`  ${published.url}`);
  },
});
