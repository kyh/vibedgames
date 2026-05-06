#!/usr/bin/env tsx
/**
 * Undo dogfood: unlink the local vg CLI.
 * Plugin-skill symlinks under .claude/skills/ are committed to the repo;
 * use `git checkout .claude/skills/` to restore them if you delete by hand.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("→ unlinking vg CLI");
spawnSync("npm", ["unlink", "-g", "vibedgames"], {
  cwd: join(ROOT, "apps/cli"),
  stdio: "inherit",
});

console.log("✓ done.");
