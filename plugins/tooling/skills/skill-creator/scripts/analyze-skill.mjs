#!/usr/bin/env node
/**
 * Heuristic quality analysis of a skill: does it establish a philosophy, warn
 * about anti-patterns, encourage variation, organise itself, and empower
 * rather than constrain.
 *
 * Usage:
 *   node analyze-skill.mjs <path/to/skill>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeSkillBody, parseFrontmatter } from "./_lib/asset-tools.mjs";

const [skillPath] = process.argv.slice(2);
const USAGE = "Usage: node analyze-skill.mjs <path/to/skill>";
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

// Split on the first two `---` fences, matching the original's
// `content.split('---', 2)`.
const content = readFileSync(skillMd, "utf8");
const parts = content.split("---");
if (parts.length < 3) {
  console.log("❌ Invalid SKILL.md format - missing frontmatter");
  process.exit(1);
}
const frontmatter = parseFrontmatter(parts[1]);
const body = parts.slice(2).join("---").trim();

console.log(`\n🔍 Analyzing skill at: ${skillPath}\n`);

const analysis = analyzeSkillBody(frontmatter, body);
const rule = "=".repeat(60);

console.log(rule);
console.log(`SKILL QUALITY ANALYSIS: ${analysis.name}`);
console.log(rule);
console.log(`\n📊 OVERALL SCORE: ${analysis.totalScore}/100\n`);

for (const { category, score, feedback } of analysis.categories) {
  console.log(`\n${category}: ${score} points`);
  for (const item of feedback) console.log(`  ${item}`);
}

console.log(`\n${rule}`);
console.log("RECOMMENDATIONS");
console.log(rule);

const scoreOf = (name) => analysis.categories.find((c) => c.category === name)?.score ?? 0;

if (analysis.totalScore >= 80) {
  console.log("\n🌟 Excellent! This skill follows best practices.");
} else if (analysis.totalScore >= 60) {
  console.log("\n✅ Good skill. Consider the suggestions above to improve.");
} else if (analysis.totalScore >= 40) {
  console.log("\n⚠️  Needs improvement. Focus on:");
  if (scoreOf("Philosophy") < 20) console.log("   - Add philosophical foundation");
  if (scoreOf("Anti-Patterns") < 15) console.log("   - Include anti-pattern warnings");
  if (scoreOf("Variation") < 10) console.log("   - Encourage variation in outputs");
} else {
  console.log("\n❌ Significant improvements needed:");
  console.log("   - Establish a clear philosophical framework");
  console.log("   - Add explicit anti-patterns section");
  console.log("   - Encourage context-specific variation");
  console.log("   - Improve organization and structure");
}

console.log("\n");
