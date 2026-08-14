import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FrontmatterError, parseFrontmatter } from "./frontmatter.js";

/**
 * Structural validation of a skill directory — the checks that decide whether
 * a skill will load at all, kept separate from the quality analysis.
 */

const ALLOWED_PROPERTIES = ["name", "description", "license", "allowed-tools", "metadata"];

export function validateSkill(skillPath: string): { valid: boolean; message: string } {
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

  let frontmatter: Record<string, unknown>;
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
  if (typeof rawName !== "string") {
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
  if (typeof rawDescription !== "string") {
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
function typeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    default:
      return "dict";
  }
}
