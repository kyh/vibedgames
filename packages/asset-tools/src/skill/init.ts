import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { EXAMPLE_ASSET, EXAMPLE_REFERENCE, EXAMPLE_SCRIPT, SKILL_TEMPLATE } from "./templates.js";

/** Hyphenated skill name to Title Case, for display in the scaffold. */
export const titleCaseSkillName = (skillName: string): string =>
  skillName
    .split("-")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");

export interface InitResult {
  dir: string;
  created: string[];
}

/**
 * Scaffold a new skill directory: SKILL.md from the template plus example
 * `scripts/`, `references/` and `assets/` entries. Returns null when the
 * directory already exists, so an existing skill is never overwritten.
 */
export const initSkill = (
  skillName: string,
  parentDir: string,
  log: (message: string) => void,
): InitResult | null => {
  const skillDir = path.join(path.resolve(parentDir), skillName);
  if (existsSync(skillDir)) {
    log(`❌ Error: Skill directory already exists: ${skillDir}`);
    return null;
  }

  const created: string[] = [];
  try {
    mkdirSync(skillDir, { recursive: true });
    log(`✅ Created skill directory: ${skillDir}`);
  } catch (error) {
    log(`❌ Error creating directory: ${error instanceof Error ? error.message : error}`);
    return null;
  }

  const skillTitle = titleCaseSkillName(skillName);
  try {
    writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_TEMPLATE(skillName, skillTitle));
    log("✅ Created SKILL.md");
    created.push("SKILL.md");
  } catch (error) {
    log(`❌ Error creating SKILL.md: ${error instanceof Error ? error.message : error}`);
    return null;
  }

  try {
    const scriptsDir = path.join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "example.mjs");
    writeFileSync(scriptPath, EXAMPLE_SCRIPT(skillName));
    chmodSync(scriptPath, 0o755);
    log("✅ Created scripts/example.mjs");
    created.push("scripts/example.mjs");

    const referencesDir = path.join(skillDir, "references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(path.join(referencesDir, "api_reference.md"), EXAMPLE_REFERENCE(skillTitle));
    log("✅ Created references/api_reference.md");
    created.push("references/api_reference.md");

    const assetsDir = path.join(skillDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "example_asset.txt"), EXAMPLE_ASSET);
    log("✅ Created assets/example_asset.txt");
    created.push("assets/example_asset.txt");
  } catch (error) {
    log(
      `❌ Error creating resource directories: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }

  return { created, dir: skillDir };
};
