#!/usr/bin/env node
/**
 * Heuristic quality analysis of a skill: is the description short and
 * trigger-precise, is the root a router over references and scripts, does it
 * carry concrete facts rather than itinerary, name its traps, and say how to
 * verify the result.
 *
 * Usage:
 *   node analyze-skill.mjs <path/to/skill>
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

const skillMd = path.join(skillPath, "SKILL.md");
if (!existsSync(skillMd)) {
  console.log(`❌ SKILL.md not found at ${skillMd}`);
  process.exit(1);
}

// Split on the first two `---` fences, matching the original's
// `content.split('---', 2)`.
const content = readFileSync(skillMd, "utf-8");
const parts = content.split("---");
if (parts.length < 3) {
  console.log("❌ Invalid SKILL.md format - missing frontmatter");
  process.exit(1);
}
const frontmatter = parseFrontmatter(parts[1]);
const body = parts.slice(2).join("---").trim();

console.log(`\n🔍 Analyzing skill at: ${skillPath}\n`);

const analysis = analyzeSkillBody(frontmatter, body, {
  hasReferences: existsSync(path.join(skillPath, "references")),
  hasScripts: existsSync(path.join(skillPath, "scripts")),
});
const rule = "=".repeat(60);

console.log(rule);
console.log(`SKILL QUALITY ANALYSIS: ${analysis.name}`);
console.log(rule);
console.log(`\n📊 OVERALL SCORE: ${analysis.totalScore}/100\n`);

for (const { category, score, feedback } of analysis.categories) {
  console.log(`\n${category}: ${score} points`);
  for (const item of feedback) {
    console.log(`  ${item}`);
  }
}

console.log(`\n${rule}`);
console.log("RECOMMENDATIONS");
console.log(rule);

const scoreOf = (name) => analysis.categories.find((c) => c.category === name)?.score ?? 0;

if (analysis.totalScore >= 80) {
  console.log("\n🌟 Loads when it should and costs little to read.");
} else if (analysis.totalScore >= 60) {
  console.log("\n✅ Sound. The lowest categories above are the cheap wins.");
} else {
  console.log("\n⚠️  Needs work. Start with:");
  if (scoreOf("Description") < 15) {
    console.log("   - Shorten the description to one trigger-precise sentence");
  }
  if (scoreOf("Router") < 15) {
    console.log("   - Move depth into references/ and make the root point at it");
  }
  if (scoreOf("Verification") < 8) {
    console.log("   - Say how the output is verified without a human");
  }
  if (scoreOf("Anti-Patterns") < 8) {
    console.log("   - Name the traps a naive attempt falls into");
  }
}

console.log("\n");
