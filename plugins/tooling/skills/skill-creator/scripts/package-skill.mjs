#!/usr/bin/env node
/**
 * Skill Packager — creates a distributable .skill file of a skill folder.
 *
 * Usage:
 *   node package-skill.mjs <path/to/skill-folder> [output-directory]
 *
 * Example:
 *   node package-skill.mjs skills/public/my-skill
 *   node package-skill.mjs skills/public/my-skill ./dist
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { createZip, validateSkill } from "./_lib/asset-tools.mjs";

/** Every file under `dir`, sorted, so an archive is reproducible. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function packageSkill(skillPathArg, outputDir) {
  const skillPath = resolve(skillPathArg);

  if (!existsSync(skillPath)) {
    console.log(`❌ Error: Skill folder not found: ${skillPath}`);
    return null;
  }
  if (!statSync(skillPath).isDirectory()) {
    console.log(`❌ Error: Path is not a directory: ${skillPath}`);
    return null;
  }
  if (!existsSync(join(skillPath, "SKILL.md"))) {
    console.log(`❌ Error: SKILL.md not found in ${skillPath}`);
    return null;
  }

  console.log("🔍 Validating skill...");
  const { valid, message } = validateSkill(skillPath);
  if (!valid) {
    console.log(`❌ Validation failed: ${message}`);
    console.log("   Please fix the validation errors before packaging.");
    return null;
  }
  console.log(`✅ ${message}\n`);

  const outputPath = outputDir ? resolve(outputDir) : process.cwd();
  if (outputDir) mkdirSync(outputPath, { recursive: true });
  const skillFilename = join(outputPath, `${basename(skillPath)}.skill`);

  try {
    // Paths inside the archive are relative to the skill's parent, so the
    // bundle unpacks as a named skill directory rather than loose files.
    const parent = dirname(skillPath);
    const entries = walk(skillPath).map((file) => {
      const arcname = relative(parent, file).split(/[/\\]/).join("/");
      console.log(`  Added: ${arcname}`);
      return { name: arcname, data: readFileSync(file), mtime: statSync(file).mtime };
    });

    writeFileSync(skillFilename, createZip(entries));
    console.log(`\n✅ Successfully packaged skill to: ${skillFilename}`);
    return skillFilename;
  } catch (error) {
    console.log(`❌ Error creating .skill file: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

const [skillPath, outputDir] = process.argv.slice(2);
const USAGE = [
  "Usage: node package-skill.mjs <path/to/skill-folder> [output-directory]",
  "",
  "Example:",
  "  node package-skill.mjs skills/public/my-skill",
  "  node package-skill.mjs skills/public/my-skill ./dist",
].join("\n");
if (skillPath === "--help" || skillPath === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (!skillPath) {
  console.error(USAGE);
  process.exit(2);
}

console.log(`📦 Packaging skill: ${skillPath}`);
if (outputDir) console.log(`   Output directory: ${outputDir}`);
console.log();

process.exit(packageSkill(skillPath, outputDir) ? 0 : 1);
