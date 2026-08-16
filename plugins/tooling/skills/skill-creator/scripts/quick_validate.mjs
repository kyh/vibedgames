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

const USAGE = "Usage: node quick_validate.mjs <skill_directory>";
if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.length !== 3) {
  console.error(USAGE);
  process.exit(2);
}

const { valid, message } = validateSkill(process.argv[2]);
console.log(message);
process.exit(valid ? 0 : 1);
