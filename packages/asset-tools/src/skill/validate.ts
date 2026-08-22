import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isFiniteJsonNumber, isJsonString } from "../asset/json.js";
import { FrontmatterError, parseFrontmatter, type YamlValue } from "./frontmatter.js";

/**
 * Structural validation of a skill directory — the checks that decide whether
 * a skill will load at all, kept separate from the quality analysis.
 */

/** The keys the SKILL.md spec allows; anything else fails packaging upstream. */
const ALLOWED_PROPERTIES = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "compatibility",
  "metadata",
];

export type SkillValidation = { valid: boolean; message: string };

export function validateSkill(skillPath: string): SkillValidation {
  const skillMd = join(skillPath, "SKILL.md");
  if (!existsSync(skillMd)) return { valid: false, message: "SKILL.md not found" };

  const content = readFileSync(skillMd, "utf8");
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return { valid: false, message: "Invalid frontmatter format" };
  const frontmatterText = match[1]!;

  // Folded/literal scalars parse fine here but break stricter frontmatter
  // readers elsewhere in the toolchain, so they are rejected up front.
  if (/^description:\s*[>|]-?\s*$/m.test(frontmatterText)) {
    return {
      valid: false,
      message:
        "Description must use an inline string value, not YAML folded/literal scalar (`>` or `|`).",
    };
  }

  // An unquoted scalar containing ": " is a nested mapping to a strict YAML
  // parser, which is what actually installs these skills. Our own parser splits
  // on the first colon and reads it fine, so this passed validation and then
  // failed to install — `skills add` skipped the release skill outright.
  for (const line of frontmatterText.split("\n")) {
    const match = /^([a-z-]+):\s+(?!["'|>])(.*)$/i.exec(line);
    if (match && match[2]!.includes(": ")) {
      return {
        valid: false,
        message:
          `\`${match[1]}\` contains ": " but is not quoted, which strict YAML reads as a ` +
          `nested mapping — the installer will skip this skill. Wrap the value in quotes.`,
      };
    }
  }

  let frontmatter: Record<string, YamlValue>;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    return { valid: false, message: `Invalid YAML in frontmatter: ${detail}` };
  }

  const unexpected = Object.keys(frontmatter)
    .filter((key) => !ALLOWED_PROPERTIES.includes(key))
    .sort();
  if (unexpected.length > 0) {
    return {
      valid: false,
      message:
        `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. ` +
        `Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`,
    };
  }

  if (!("name" in frontmatter)) return { valid: false, message: "Missing 'name' in frontmatter" };
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const rawName = frontmatter.name;
  if (!isJsonString(rawName)) {
    return { valid: false, message: `Name must be a string, got ${typeName(rawName)}` };
  }
  const name = rawName.trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    if (name.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is 64 characters.`,
      };
    }
  }

  const rawDescription = frontmatter.description;
  if (!isJsonString(rawDescription)) {
    return {
      valid: false,
      message: `Description must be a string, got ${typeName(rawDescription)}`,
    };
  }
  const description = rawDescription.trim();
  if (description) {
    // Angle brackets break the tool-definition XML the description is embedded in.
    if (description.includes("<") || description.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      };
    }
  }

  return { valid: true, message: "Skill is valid!" };
}

/** Python's `type(x).__name__` for the types frontmatter can produce. */
function typeName(value: YamlValue | undefined): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (isJsonString(value)) return "str";
  if (value === true || value === false) return "bool";
  if (isFiniteJsonNumber(value)) return Number.isInteger(value) ? "int" : "float";
  return "dict";
}
