#!/usr/bin/env node
/**
 * Skill Initializer — creates a new skill from template.
 *
 * Usage:
 *   node init_skill.mjs <skill-name> --path <path>
 *
 * Examples:
 *   node init_skill.mjs my-new-skill --path skills/public
 *   node init_skill.mjs my-api-helper --path skills/private
 *   node init_skill.mjs custom-skill --path /custom/location
 */
import { initSkill } from "./_lib/asset-tools.mjs";

const argv = process.argv.slice(2);
if (argv.length < 3 || argv[1] !== "--path") {
  console.log("Usage: node init_skill.mjs <skill-name> --path <path>");
  console.log("\nSkill name requirements:");
  console.log("  - Hyphen-case identifier (e.g., 'data-analyzer')");
  console.log("  - Lowercase letters, digits, and hyphens only");
  console.log("  - Max 40 characters");
  console.log("  - Must match directory name exactly");
  console.log("\nExamples:");
  console.log("  node init_skill.mjs my-new-skill --path skills/public");
  console.log("  node init_skill.mjs my-api-helper --path skills/private");
  console.log("  node init_skill.mjs custom-skill --path /custom/location");
  process.exit(1);
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
