#!/usr/bin/env node
/**
 * Skill Initializer — creates a new skill from template.
 *
 * Usage:
 *   node init-skill.mjs <skill-name> --path <path>
 *
 * Examples:
 *   node init-skill.mjs my-new-skill --path skills/public
 *   node init-skill.mjs my-api-helper --path skills/private
 *   node init-skill.mjs custom-skill --path /custom/location
 */
import { initSkill } from "./_lib/asset-tools.mjs";

const argv = process.argv.slice(2);
const USAGE = [
  "Usage: node init-skill.mjs <skill-name> --path <path>",
  "",
  "Skill name requirements:",
  "  - Hyphen-case identifier (e.g., 'data-analyzer')",
  "  - Lowercase letters, digits, and hyphens only",
  "  - Max 40 characters",
  "  - Must match directory name exactly",
  "",
  "Examples:",
  "  node init-skill.mjs my-new-skill --path skills/public",
  "  node init-skill.mjs my-api-helper --path skills/private",
  "  node init-skill.mjs custom-skill --path /custom/location",
].join("\n");
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (argv.length < 3 || argv[1] !== "--path") {
  console.error(USAGE);
  process.exit(2);
}

const [skillName, , path] = argv;

console.log(`🚀 Initializing skill: ${skillName}`);
console.log(`   Location: ${path}`);
console.log();

const result = initSkill(skillName, path, (message) => console.log(message));
if (!result) process.exit(1);

console.log(`\n✅ Skill '${skillName}' initialized successfully at ${result.dir}`);
console.log("\nNext steps:");
console.log("1. Edit SKILL.md to complete the TODO items and update the description");
console.log("2. Customize or delete the example files in scripts/, references/, and assets/");
console.log("3. Run the validator when ready to check the skill structure");
