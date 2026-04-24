#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/lib/install.md");
const publicDir = resolve(here, "../public");

const targets = ["install.md", "llms.txt", "llms-install.md", "claude.md"];

mkdirSync(publicDir, { recursive: true });
for (const name of targets) {
  copyFileSync(source, resolve(publicDir, name));
}

console.log(`synced install.md → ${targets.join(", ")}`);
