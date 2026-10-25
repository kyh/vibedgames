import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { createClient } from "../lib/api.js";
import { packBuild, packSource } from "../lib/archive.js";
import type { SourceArchive } from "../lib/archive.js";
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

const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
type Say = (message: string) => void;

/** Build-tool projects (package.json present): the root index.html is the
 *  source template, the playable game lives in the build output. Deploying the
 *  root uploads the whole source tree — wrong content and usually over the file
 *  caps — so prefer a build directory when one exists. Checked in popularity
 *  order: Vite/Rollup/Parcel → CRA/Preact → Next export/esbuild. */
const resolveDeployDir = (dir: string, say: Say): string => {
  if (!existsSync(path.join(dir, "package.json"))) {
    return dir;
  }
  for (const name of ["dist", "build", "out"]) {
    if (existsSync(path.join(dir, name, "index.html"))) {
      say(`Project root detected — deploying its build output ${name}/ instead.`);
      return path.join(dir, name);
    }
  }
  consola.warn(
    "This looks like an unbuilt project (package.json, no dist/build/out) — " +
      "run the build first, or the deployed index.html will reference missing source files.",
  );
  return dir;
};

const promptForConfig = async (dir: string, say: Say): Promise<ProjectConfig> => {
  if (!process.stdin.isTTY) {
    consola.error(
      "No slug specified and no vibedgames.json found.\n" +
        "  Pass --slug <name> when running without a TTY (e.g. in CI or from a coding agent).\n" +
        "  Example: vg deploy ./dist --slug my-game",
    );
    process.exit(1);
  }
  // isJsonString: consola.prompt is typed to resolve a string but can resolve a
  // cancel sentinel at runtime, and a symbol would throw inside RegExp.test.
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

const resolveDeployConfig = async (
  dir: string,
  slugOverride: string | undefined,
  say: Say,
): Promise<ProjectConfig> => {
  let config: ProjectConfig | null = null;
  try {
    config = readProjectConfig(dir);
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (slugOverride) {
    config = { name: config?.name, slug: slugOverride };
  }
  config ??= await promptForConfig(dir, say);
  if (!SLUG_RE.test(config.slug)) {
    consola.error(`Invalid slug in vibedgames.json: ${config.slug}`);
    process.exit(1);
  }
  return config;
};

const packForkableSource = async (
  dir: string,
  slug: string,
  say: Say,
): Promise<SourceArchive | null> => {
  const root = findProjectRoot(dir);
  if (!root) {
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

/** PUTs an archive to a signed upload URL; throws with what went wrong. */
const putArchive = async (
  archivePath: string,
  upload: { url: string; headers: Record<string, string> },
  what: string,
): Promise<void> => {
  const res = await fetch(upload.url, {
    body: readFileSync(archivePath),
    headers: upload.headers,
    method: "PUT",
  });
  if (!res.ok) {
    throw new Error(`${what} upload failed: ${res.status} ${res.statusText}`);
  }
};

/** Makes the staged deployment live; until now the previous one kept serving. */
const publishDeployment = async (
  client: ReturnType<typeof createClient>,
  { deploymentId, slug }: { deploymentId: string; slug: string },
): Promise<{ url: string }> => {
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

    // Progress narration shares stdout with the payload, so it has to go quiet
    // whenever stdout is the result rather than a story about it.
    const structured = isJsonOutput(args) || Boolean(args.field);
    const say = structured
      ? () => {
          /* empty */
        }
      : (message: string) => consola.info(message);

    const dir = path.resolve(args.dir);

    if (!existsSync(dir)) {
      consola.error(`Directory does not exist: ${dir}`);
      process.exit(1);
    }

    const deployDir = resolveDeployDir(dir, say);

    const config = await resolveDeployConfig(dir, args.slug, say);

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
    say(`Deploying ${config.slug}: ${manifest.length} files, ${formatBytes(totalBytes)}`);

    // ---- Pack forkable source (opt-in: source is a publish, --source) -------
    const sourceArchive = args.source ? await packForkableSource(dir, config.slug, say) : null;

    // ---- Pack the build into one bundle ------------------------------------
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

    // ---- Stage a deployment beside the live one, and upload into it ---------
    const client = createClient();
    const started = Date.now();

    let created;
    try {
      created = await client.deploy.upload({
        bundle: true,
        name: config.name,
        slug: config.slug,
        sourceArchive: sourceArchive
          ? { bytes: sourceArchive.bytes, sha256: sourceArchive.sha256 }
          : undefined,
      });
      if (!structured) {
        consola.start(`Uploading ${formatBytes(bundle.bytes)}`);
      }
      if (!created.bundleUpload) {
        throw new Error("The server returned no bundle upload URL.");
      }
      await putArchive(bundle.path, created.bundleUpload, "bundle");
      if (sourceArchive && created.sourceUpload) {
        await putArchive(sourceArchive.path, created.sourceUpload, "source");
      }
    } catch (error) {
      cleanUp();
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    cleanUp();

    // ---- Publish ------------------------------------------------------------
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
