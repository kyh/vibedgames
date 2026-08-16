#!/usr/bin/env node
/**
 * Generate suggestions for improving an existing skill.
 *
 * Where analyze_skill.mjs scores a skill, this proposes the specific section
 * that is missing and shows what it should look like.
 *
 * Usage:
 *   node upgrade_skill.mjs <path/to/skill>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSuggestions, parseFrontmatter } from "./_lib/asset-tools.mjs";

const [skillPath] = process.argv.slice(2);
const USAGE = "Usage: node upgrade_skill.mjs <path/to/skill>";
if (skillPath === "--help" || skillPath === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (process.argv.length !== 3) {
  console.error(USAGE);
  process.exit(2);
}
if (!existsSync(skillPath)) {
  console.log(`❌ Skill directory not found: ${skillPath}`);
  process.exit(1);
}

const skillMd = join(skillPath, "SKILL.md");
if (!existsSync(skillMd)) {
  console.log(`❌ SKILL.md not found at ${skillMd}`);
  process.exit(1);
}

const content = readFileSync(skillMd, "utf8");
const parts = content.split("---");
if (parts.length < 3) {
  console.log("❌ Invalid SKILL.md format - missing frontmatter");
  process.exit(1);
}
const frontmatter = parseFrontmatter(parts[1]);
const body = parts.slice(2).join("---").trim();

console.log(`\n🔧 Analyzing upgrade opportunities for: ${skillPath}\n`);

const suggestions = generateSuggestions(frontmatter, body);
const rule = "=".repeat(70);

console.log(rule);
console.log(`UPGRADE SUGGESTIONS: ${frontmatter.name ?? "unknown"}`);
console.log(rule);

if (suggestions.length === 0) {
  console.log("\n✅ No major improvements needed! This skill follows best practices.\n");
  process.exit(0);
}

for (const [priority, heading] of [
  ["HIGH", "🔴 HIGH PRIORITY IMPROVEMENTS"],
  ["MEDIUM", "🟡 MEDIUM PRIORITY IMPROVEMENTS"],
  ["LOW", "🟢 LOW PRIORITY IMPROVEMENTS"],
]) {
  const group = suggestions.filter((s) => s.priority === priority);
  if (group.length === 0) continue;
  console.log(`\n${heading}`);
  console.log("-".repeat(70));
  group.forEach((s, i) => {
    console.log(`\n${i + 1}. ${s.category}: ${s.suggestion}`);
    console.log(`\nExample:\n${s.example}\n`);
  });
}

console.log(rule);
console.log("NEXT STEPS");
console.log(rule);
console.log(`
1. Review the suggestions above
2. Edit your SKILL.md to incorporate relevant improvements
3. Run analyze_skill.mjs to see how the score improves
4. Test the skill with real use cases
5. Iterate based on performance
    `);
