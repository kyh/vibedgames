import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { createClient } from "../lib/api.js";
import { extractSource } from "../lib/archive.js";
import { SLUG_RE } from "../lib/config-file.js";
import { isJsonOutput, outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { isJsonObject } from "../lib/types.js";
import type { JsonValue } from "../lib/types.js";

const forkArgs = {
  force: {
    default: false,
    description: "Overwrite the target directory if it exists.",
    type: "boolean",
  },
  name: {
    description: "Display name for the fork (defaults to the target slug).",
    type: "string",
  },
  slug: {
    description: "Slug of the project to fork (e.g. bomberman).",
    required: true,
    type: "positional",
  },
  target: {
    description: "New slug + directory for the fork. Defaults to <slug>-fork.",
    required: false,
    type: "positional",
  },
  ...outputArgs,
} as const;

const rewritePackageName = (dir: string, slug: string): void => {
  const pkgPath = path.resolve(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }
  try {
    const pkg: JsonValue = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!isJsonObject(pkg)) {
      throw new Error("package.json is not a JSON object");
    }
    pkg.name = slug;
    delete pkg.repository;
    delete pkg.bugs;
    delete pkg.homepage;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (error) {
    consola.warn(
      `Could not rewrite package.json name: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
export const forkCommand = defineCommand({
  args: forkArgs,
  meta: {
    description:
      "Fork another project's source so you can build on it. Downloads the source a project shipped with `vg deploy`, extracts it locally, and rewrites it to a new slug.",
    name: "fork",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, forkArgs);

    const source = args.slug.trim().toLowerCase();
    const target = (args.target ?? `${source}-fork`).trim().toLowerCase();
    if (!SLUG_RE.test(target)) {
      consola.error(`Invalid target slug "${target}". Use lowercase letters, digits, and hyphens.`);
      process.exit(1);
    }

    const dir = path.resolve(process.cwd(), target);
    if (existsSync(dir)) {
      if (!args.force) {
        consola.error(
          `Directory ${dir} already exists. Pass --force to overwrite, or pick another target.`,
        );
        process.exit(1);
      }
      // --force means replace, not merge — clear stale files first so the fork
      // isn't a dirty mix of the archive and whatever was already there.
      rmSync(dir, { force: true, recursive: true });
    }

    const client = createClient();

    // ---- Resolve + download source -----------------------------------------
    if (!isJsonOutput(args) && !args.field) {
      consola.start(`Forking ${source}`);
    }
    let src;
    try {
      src = await client.deploy.getSource({ slug: source });
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    const tmp = path.join(tmpdir(), "vibedgames", `fork-${process.pid}.tgz`);
    mkdirSync(path.join(tmpdir(), "vibedgames"), { recursive: true });
    try {
      const res = await fetch(src.url);
      if (!res.ok) {
        throw new Error(`download failed: ${res.status} ${res.statusText}`);
      }
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      await extractSource(tmp, dir);
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      rmSync(tmp, { force: true });
    }

    // ---- Re-slug the fork (clean slate — no provenance recorded) ------------
    const name = args.name ?? target.replaceAll("-", " ");
    writeFileSync(
      path.resolve(dir, "vibedgames.json"),
      `${JSON.stringify({ name, slug: target }, null, 2)}\n`,
    );
    rewritePackageName(dir, target);

    if (writeStructured({ dir, forkedFrom: source, slug: target }, args)) {
      return;
    }

    consola.success(`Forked ${source} → ${target}`);
    consola.log(`  ${dir}`);
    consola.log("");
    consola.info("Next steps:");
    consola.log(`  cd ${target}`);
    consola.log("  npm install");
    consola.log("  npm run dev");
    consola.log(`  # then: npm run build && vg deploy ./dist  → ${target}.vibedgames.com`);
  },
});
