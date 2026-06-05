import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import { extractSource } from "../lib/archive.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const forkCommand = defineCommand({
  meta: {
    name: "fork",
    description:
      "Fork another project's source so you can build on it. Downloads the source a project shipped with `vg deploy`, extracts it locally, and rewrites it to a new slug.",
  },
  args: {
    slug: {
      type: "positional",
      description: "Slug of the project to fork (e.g. bomberman).",
      required: true,
    },
    target: {
      type: "positional",
      description: "New slug + directory for the fork. Defaults to <slug>-fork.",
      required: false,
    },
    name: {
      type: "string",
      description: "Display name for the fork (defaults to the target slug).",
    },
    force: {
      type: "boolean",
      description: "Overwrite the target directory if it exists.",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON (for agents).",
      default: false,
    },
  },
  run: async ({ args }) => {
    const source = args.slug.trim().toLowerCase();
    const target = (args.target ?? `${source}-fork`).trim().toLowerCase();
    if (!SLUG_RE.test(target)) {
      consola.error(`Invalid target slug "${target}". Use lowercase letters, digits, and hyphens.`);
      process.exit(1);
    }

    const dir = resolve(process.cwd(), target);
    if (existsSync(dir)) {
      if (!args.force) {
        consola.error(
          `Directory ${dir} already exists. Pass --force to overwrite, or pick another target.`,
        );
        process.exit(1);
      }
      // --force means replace, not merge — clear stale files first so the fork
      // isn't a dirty mix of the archive and whatever was already there.
      rmSync(dir, { recursive: true, force: true });
    }

    const client = createClient();

    // ---- Resolve + download source -----------------------------------------
    if (!args.json) consola.start(`Forking ${source}`);
    let src;
    try {
      src = await client.deploy.getSource.query({ slug: source });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const tmp = join(tmpdir(), "vibedgames", `fork-${process.pid}.tgz`);
    mkdirSync(join(tmpdir(), "vibedgames"), { recursive: true });
    try {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      await extractSource(tmp, dir);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      rmSync(tmp, { force: true });
    }

    // ---- Re-slug the fork (clean slate — no provenance recorded) ------------
    const name = args.name ?? target.replace(/-/g, " ");
    writeFileSync(
      resolve(dir, "vibedgames.json"),
      `${JSON.stringify({ slug: target, name }, null, 2)}\n`,
    );
    rewritePackageName(dir, target);

    if (args.json) {
      consola.log(JSON.stringify({ slug: target, dir, forkedFrom: source }));
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

function rewritePackageName(dir: string, slug: string): void {
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.name = slug;
    delete pkg.repository;
    delete pkg.bugs;
    delete pkg.homepage;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (err) {
    consola.warn(
      `Could not rewrite package.json name: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
