import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isFiniteJsonNumber, isJsonString } from "../asset/json.js";
import { FrontmatterError, parseFrontmatter } from "./frontmatter.js";
import type { YamlValue } from "./frontmatter.js";

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

export interface SkillValidation {
  valid: boolean;
  message: string;
}

/** Python's `type(x).__name__` for the types frontmatter can produce. */
const typeName = (value: YamlValue | undefined): string => {
  if (value === null) {
    return "NoneType";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  if (isJsonString(value)) {
    return "str";
  }
  if (value === true || value === false) {
    return "bool";
  }
  if (isFiniteJsonNumber(value)) {
    return Number.isInteger(value) ? "int" : "float";
  }
  return "dict";
};

const UNQUOTED_VALUE_RE = /^(?<key>[a-z-]+):\s+(?!["'|>])(?<value>.*)$/iu;

/**
 * An unquoted scalar containing ": " is a nested mapping to a strict YAML
 * parser, which is what actually installs these skills. Our own parser splits
 * on the first colon and reads it fine, so this passed validation and then
 * failed to install — `skills add` skipped the release skill outright.
 */
const findUnquotedColon = (frontmatterText: string): SkillValidation | null => {
  for (const line of frontmatterText.split("\n")) {
    const groups = UNQUOTED_VALUE_RE.exec(line)?.groups;
    if (groups?.value?.includes(": ")) {
      return {
        message:
          `\`${groups.key}\` contains ": " but is not quoted, which strict YAML reads as a ` +
          `nested mapping — the installer will skip this skill. Wrap the value in quotes.`,
        valid: false,
      };
    }
  }
  return null;
};

const validateName = (rawName: YamlValue | undefined): SkillValidation | null => {
  if (!isJsonString(rawName)) {
    return { message: `Name must be a string, got ${typeName(rawName)}`, valid: false };
  }
  const name = rawName.trim();
  if (!name) {
    return null;
  }
  if (!/^[a-z0-9-]+$/u.test(name)) {
    return {
      message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      valid: false,
    };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return {
      message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      valid: false,
    };
  }
  if (name.length > 64) {
    return {
      message: `Name is too long (${name.length} characters). Maximum is 64 characters.`,
      valid: false,
    };
  }
  return null;
};

const validateDescription = (rawDescription: YamlValue | undefined): SkillValidation | null => {
  if (!isJsonString(rawDescription)) {
    return {
      message: `Description must be a string, got ${typeName(rawDescription)}`,
      valid: false,
    };
  }
  const description = rawDescription.trim();
  if (!description) {
    return null;
  }
  // Angle brackets break the tool-definition XML the description is embedded in.
  if (description.includes("<") || description.includes(">")) {
    return { message: "Description cannot contain angle brackets (< or >)", valid: false };
  }
  if (description.length > 1024) {
    return {
      message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      valid: false,
    };
  }
  return null;
};

export const validateSkill = (skillPath: string): SkillValidation => {
  const skillMd = path.join(skillPath, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { message: "SKILL.md not found", valid: false };
  }

  const content = readFileSync(skillMd, "utf-8");
  if (!content.startsWith("---")) {
    return { message: "No YAML frontmatter found", valid: false };
  }

  const frontmatterText = /^---\n(?<front>[\s\S]*?)\n---/u.exec(content)?.groups?.front;
  if (frontmatterText === undefined) {
    return { message: "Invalid frontmatter format", valid: false };
  }

  // Folded/literal scalars parse fine here but break stricter frontmatter
  // readers elsewhere in the toolchain, so they are rejected up front.
  if (/^description:\s*[>|]-?\s*$/mu.test(frontmatterText)) {
    return {
      message:
        "Description must use an inline string value, not YAML folded/literal scalar (`>` or `|`).",
      valid: false,
    };
  }

  const unquoted = findUnquotedColon(frontmatterText);
  if (unquoted) {
    return unquoted;
  }

  let frontmatter: Record<string, YamlValue>;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    return { message: `Invalid YAML in frontmatter: ${detail}`, valid: false };
  }

  const unexpected = Object.keys(frontmatter)
    .filter((key) => !ALLOWED_PROPERTIES.includes(key))
    .toSorted();
  if (unexpected.length > 0) {
    return {
      message:
        `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. ` +
        `Allowed properties are: ${[...ALLOWED_PROPERTIES].toSorted().join(", ")}`,
      valid: false,
    };
  }

  if (!("name" in frontmatter)) {
    return { message: "Missing 'name' in frontmatter", valid: false };
  }
  if (!("description" in frontmatter)) {
    return { message: "Missing 'description' in frontmatter", valid: false };
  }

  return (
    validateName(frontmatter.name) ??
    validateDescription(frontmatter.description) ?? { message: "Skill is valid!", valid: true }
  );
};
