#!/usr/bin/env node
/**
 * Quick structural validation of a skill directory: frontmatter present and
 * parseable, only allowed keys, name in hyphen-case and within length, and a
 * description that will survive being embedded in a tool definition.
 *
 * Usage:
 *   node quick_validate.mjs <skill_directory>
 */
import { validateSkill } from "./_lib/asset-tools.mjs";

if (process.argv.length !== 3) {
  console.log("Usage: node quick_validate.mjs <skill_directory>");
  process.exit(1);
}

const { valid, message } = validateSkill(process.argv[2]);
console.log(message);
process.exit(valid ? 0 : 1);
