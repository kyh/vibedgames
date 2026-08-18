// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/image/png.ts
var SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
var crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  recommendedFrames,
  fps,
  timing,
  loopable,
  selectionPolicy
});
var ACTIONS = {
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window")
};

// src/skill/frontmatter.ts
var FrontmatterError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontmatterError";
  }
};
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}
function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return "";
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2 || text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replaceAll(String.raw`\"`, '"').replaceAll("\\n", "\n") : body;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}
function joinBlockScalar(lines, style) {
  const indent = lines.find((l) => l.trim())?.match(/^\s*/)?.[0].length ?? 0;
  const stripped = lines.map((l) => l.slice(indent));
  const literal = style.startsWith("|");
  let text = "";
  if (literal) {
    text = stripped.join("\n");
  } else {
    for (const [i, line] of stripped.entries()) {
      if (i === 0) text = line;
      else if (line.trim() === "" || stripped[i - 1].trim() === "") text += `
${line}`;
      else text += ` ${line}`;
    }
  }
  text = text.replace(/\s+$/, "");
  return style.endsWith("-") ? text : `${text}
`;
}
function parseFrontmatter(text) {
  const out = {};
  let currentKey = null;
  let nested = null;
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i];
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    if (indented) {
      if (!nested || currentKey === null) {
        throw new FrontmatterError(`unexpected indented line: ${rawLine.trim()}`);
      }
      const match2 = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (!match2) throw new FrontmatterError(`could not parse nested line: ${rawLine.trim()}`);
      nested[match2[1].trim()] = parseScalar(match2[2]);
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) throw new FrontmatterError(`could not parse line: ${rawLine.trim()}`);
    const key = match[1].trim();
    const value = match[2];
    const block = /^([|>])([+-]?)$/.exec(value.trim());
    if (block) {
      const body = [];
      while (i + 1 < rawLines.length) {
        const next = rawLines[i + 1];
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        body.push(next);
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      currentKey = null;
      nested = null;
      out[key] = joinBlockScalar(body, block[1] + block[2]);
      continue;
    }
    if (value.trim() === "") {
      currentKey = key;
      nested = {};
      out[key] = nested;
    } else {
      currentKey = null;
      nested = null;
      out[key] = parseScalar(value);
    }
  }
  return out;
}

// src/skill/analyze.ts
function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
function keywordsFound(bodyLower, keywords) {
  return keywords.filter((keyword) => bodyLower.includes(keyword));
}
function checkPhilosophy(body) {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "philosophy",
    "approach",
    "principle",
    "mental model",
    "framework",
    "thinking",
    "mindset",
    "why",
    "consider",
    "understand"
  ]);
  if (found.length >= 3) {
    score += 30;
    feedback.push(`\u2705 Philosophy indicators found: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 15;
    feedback.push(`\u26A0\uFE0F  Some philosophy indicators found: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No clear philosophical foundation detected");
  }
  const questions = countMatches(body, /\?[^\n]*/g);
  if (questions >= 3) {
    score += 10;
    feedback.push(`\u2705 Contains ${questions} guiding questions`);
  } else if (questions >= 1) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Contains ${questions} guiding question(s)`);
  }
  return { category: "Philosophy", score, feedback };
}
function checkAntiPatterns(body) {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "avoid",
    "never",
    "don't",
    "do not",
    "anti-pattern",
    "mistake",
    "common pitfall",
    "warning",
    "incorrect",
    "wrong way"
  ]);
  if (found.length >= 5) {
    score += 25;
    feedback.push(`\u2705 Strong anti-pattern guidance: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 2) {
    score += 12;
    feedback.push(`\u26A0\uFE0F  Some anti-pattern guidance: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No explicit anti-pattern warnings");
  }
  const strong = countMatches(body, /\b(NEVER|DO NOT|DON'T)\b/g);
  if (strong > 0) {
    score += 10;
    feedback.push(`\u2705 Contains ${strong} strong warning(s)`);
  }
  return { category: "Anti-Patterns", score, feedback };
}
function checkVariation(body) {
  let score = 0;
  const feedback = [];
  const bodyLower = body.toLowerCase();
  const found = keywordsFound(bodyLower, [
    "vary",
    "variation",
    "different",
    "diverse",
    "context-specific",
    "adapt",
    "customize",
    "unique",
    "avoid repetition",
    "not the same"
  ]);
  if (found.length >= 3) {
    score += 20;
    feedback.push(`\u2705 Variation encouraged: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 10;
    feedback.push(`\u26A0\uFE0F  Some variation mentioned: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No explicit variation encouragement");
  }
  const templateWarnings = countMatches(
    bodyLower,
    /(template|repetitive|generic|cookie-cutter|converge)/g
  );
  if (templateWarnings > 0) {
    score += 10;
    feedback.push(`\u2705 Warns against generic patterns (${templateWarnings} mentions)`);
  }
  return { category: "Variation", score, feedback };
}
function checkOrganization(body) {
  let score = 0;
  const feedback = [];
  const headers = countMatches(body, /^#+\s+(.+)$/gm);
  if (headers >= 5) {
    score += 10;
    feedback.push(`\u2705 Well-structured with ${headers} sections`);
  } else if (headers >= 2) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Has ${headers} sections`);
  } else {
    feedback.push("\u274C Lacks clear organization");
  }
  const lists = countMatches(body, /^\s*[-*]\s+/gm);
  if (lists >= 10) {
    score += 5;
    feedback.push(`\u2705 Contains ${lists} list items (actionable)`);
  }
  return { category: "Organization", score, feedback };
}
function checkEmpowerment(body) {
  let score = 0;
  const feedback = [];
  const bodyLower = body.toLowerCase();
  const found = keywordsFound(bodyLower, [
    "extraordinary",
    "capable",
    "unlock",
    "enable",
    "empower",
    "creative",
    "innovative",
    "push boundaries",
    "explore"
  ]);
  if (found.length >= 3) {
    score += 10;
    feedback.push(`\u2705 Empowering tone: ${found.join(", ")}`);
  } else if (found.length >= 1) {
    score += 5;
    feedback.push(`\u26A0\uFE0F  Some empowering language: ${found.join(", ")}`);
  }
  const constraints = keywordsFound(bodyLower, ["must", "always", "required", "mandatory"]);
  if (constraints.length > 20) {
    score -= 5;
    feedback.push(`\u26A0\uFE0F  Many rigid constraints (${constraints.length} instances)`);
  }
  return { category: "Empowerment", score, feedback };
}
function analyzeSkillBody(frontmatter, body) {
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const categories = [
    description.length > 50 ? { category: "Description", score: 5, feedback: ["\u2705 Comprehensive description"] } : { category: "Description", score: 0, feedback: ["\u274C Description too brief"] },
    checkPhilosophy(body),
    checkAntiPatterns(body),
    checkVariation(body),
    checkOrganization(body),
    checkEmpowerment(body)
  ];
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : "unknown",
    totalScore: categories.reduce((sum, c) => sum + c.score, 0),
    categories
  };
}

// src/skill/upgrade.ts
function generateSuggestions(frontmatter, body) {
  const suggestions = [];
  const bodyLower = body.toLowerCase();
  if (!bodyLower.includes("philosophy") && !bodyLower.includes("principle")) {
    suggestions.push({
      category: "Philosophy",
      priority: "HIGH",
      suggestion: "Add a philosophy or principles section",
      example: `## Core Philosophy

Before diving into procedures, understand the fundamental approach:
- What is the underlying philosophy guiding this domain?
- What questions should be asked before taking action?
- What mental model helps make better decisions?`
    });
  }
  if (!bodyLower.includes("anti-pattern") && !bodyLower.slice(0, 500).includes("avoid")) {
    suggestions.push({
      category: "Anti-Patterns",
      priority: "HIGH",
      suggestion: 'Add anti-patterns or "what to avoid" section',
      example: `## Anti-Patterns to Avoid

Common mistakes when [doing this task]:
- \u274C **Template trap**: Using rigid templates that constrain creativity
- \u274C **Context blindness**: Applying same approach regardless of situation
- \u274C **Over-specification**: Adding unnecessary constraints`
    });
  }
  if (!bodyLower.includes("vary") && !bodyLower.includes("different")) {
    suggestions.push({
      category: "Variation",
      priority: "MEDIUM",
      suggestion: "Add explicit variation encouragement",
      example: `## Encouraging Variation

**IMPORTANT**: Outputs should vary based on context. Avoid converging on "favorite" patterns:
- Adapt to the specific use case
- Consider different approaches for different scenarios
- No two outputs should be identical unless requirements are identical`
    });
  }
  if (!bodyLower.includes("extraordinary") && !bodyLower.includes("capable")) {
    suggestions.push({
      category: "Empowerment",
      priority: "LOW",
      suggestion: "Add empowering conclusion",
      example: `## Remember

Claude is capable of extraordinary work in this domain. These guidelines unlock that potential\u2014they don't constrain it. Use judgment, adapt to context, and push boundaries when appropriate.`
    });
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (description.length < 100) {
    suggestions.push({
      category: "Description",
      priority: "HIGH",
      suggestion: "Expand the description field in frontmatter",
      example: `Current: ${description}

Suggested: Add more detail about when to use this skill, what triggers it, and what tasks it helps with. Aim for 100-200 characters with specific use cases.`
    });
  }
  const sectionCount = body.split("\n##").length - 1;
  if (sectionCount < 3) {
    suggestions.push({
      category: "Organization",
      priority: "MEDIUM",
      suggestion: "Add more section headers for better organization",
      example: `Organize the skill into clear sections:
## Philosophy/Principles
## Core Guidelines
## Anti-Patterns
## Examples (optional)
## Advanced Topics (optional)`
    });
  }
  return suggestions;
}

// src/skill/init.ts
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// src/skill/templates.ts
var SKILL_TEMPLATE = (skillName, skillTitle) => `---
name: ${skillName}
description: "TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it."
---

# ${skillTitle}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Structuring This Skill

[TODO: Choose the structure that best fits this skill's purpose. Common patterns:

**1. Workflow-Based** (best for sequential processes)
- Works well when there are clear step-by-step procedures
- Example: DOCX skill with "Workflow Decision Tree" \u2192 "Reading" \u2192 "Creating" \u2192 "Editing"
- Structure: ## Overview \u2192 ## Workflow Decision Tree \u2192 ## Step 1 \u2192 ## Step 2...

**2. Task-Based** (best for tool collections)
- Works well when the skill offers different operations/capabilities
- Example: PDF skill with "Quick Start" \u2192 "Merge PDFs" \u2192 "Split PDFs" \u2192 "Extract Text"
- Structure: ## Overview \u2192 ## Quick Start \u2192 ## Task Category 1 \u2192 ## Task Category 2...

**3. Reference/Guidelines** (best for standards or specifications)
- Works well for brand guidelines, coding standards, or requirements
- Example: Brand styling with "Brand Guidelines" \u2192 "Colors" \u2192 "Typography" \u2192 "Features"
- Structure: ## Overview \u2192 ## Guidelines \u2192 ## Specifications \u2192 ## Usage...

**4. Capabilities-Based** (best for integrated systems)
- Works well when the skill provides multiple interrelated features
- Example: Product Management with "Core Capabilities" \u2192 numbered capability list
- Structure: ## Overview \u2192 ## Core Capabilities \u2192 ### 1. Feature \u2192 ### 2. Feature...

Patterns can be mixed and matched as needed. Most skills combine patterns (e.g., start with task-based, add workflow for complex operations).

Delete this entire "Structuring This Skill" section when done - it's just guidance.]

## [TODO: Replace with the first main section based on chosen structure]

[TODO: Add content here. See examples in existing skills:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/templates/references as needed]

## Resources

This skill includes example resource directories that demonstrate how to organize different types of bundled resources:

### scripts/
Executable code (Python/Bash/etc.) that can be run directly to perform specific operations.

**Examples from other skills:**
- PDF skill: \`fill_fillable_fields.py\`, \`extract_form_field_info.py\` - utilities for PDF manipulation
- DOCX skill: \`document.py\`, \`utilities.py\` - Python modules for document processing

**Appropriate for:** Python scripts, shell scripts, or any executable code that performs automation, data processing, or specific operations.

**Note:** Scripts may be executed without loading into context, but can still be read by Claude for patching or environment adjustments.

### references/
Documentation and reference material intended to be loaded into context to inform Claude's process and thinking.

**Examples from other skills:**
- Product management: \`communication.md\`, \`context_building.md\` - detailed workflow guides
- BigQuery: API reference documentation and query examples
- Finance: Schema documentation, company policies

**Appropriate for:** In-depth documentation, API references, database schemas, comprehensive guides, or any detailed information that Claude should reference while working.

### assets/
Files not intended to be loaded into context, but rather used within the output Claude produces.

**Examples from other skills:**
- Brand styling: PowerPoint template files (.pptx), logo files
- Frontend builder: HTML/React boilerplate project directories
- Typography: Font files (.ttf, .woff2)

**Appropriate for:** Templates, boilerplate code, document templates, images, icons, fonts, or any files meant to be copied or used in the final output.

---

**Any unneeded directories can be deleted.** Not every skill requires all three types of resources.
`;
var EXAMPLE_REFERENCE = (skillTitle) => `# Reference Documentation for ${skillTitle}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

Example real reference docs from other skills:
- product-management/references/communication.md - Comprehensive guide for status updates
- product-management/references/context_building.md - Deep-dive on gathering context
- bigquery/references/ - API references and query examples

## When Reference Docs Are Useful

Reference docs are ideal for:
- Comprehensive API documentation
- Detailed workflow guides
- Complex multi-step processes
- Information too lengthy for main SKILL.md
- Content that's only needed for specific use cases

## Structure Suggestions

### API Reference Example
- Overview
- Authentication
- Endpoints with examples
- Error codes
- Rate limits

### Workflow Guide Example
- Prerequisites
- Step-by-step instructions
- Common patterns
- Troubleshooting
- Best practices
`;
var EXAMPLE_ASSET = `# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output Claude produces.

Example asset files from other skills:
- Brand guidelines: logo.png, slides_template.pptx
- Frontend builder: hello-world/ directory with HTML/React boilerplate
- Typography: custom-font.ttf, font-family.woff2
- Data: sample_data.csv, test_dataset.json

## Common Asset Types

- Templates: .pptx, .docx, boilerplate directories
- Images: .png, .jpg, .svg, .gif
- Fonts: .ttf, .otf, .woff, .woff2
- Boilerplate code: Project directories, starter files
- Icons: .ico, .svg
- Data files: .csv, .json, .xml, .yaml

Note: This is a text placeholder. Actual assets can be any file type.
`;
var EXAMPLE_SCRIPT = (skillName) => `#!/usr/bin/env node
/**
 * Example helper script for ${skillName}
 *
 * This is a placeholder script that can be executed directly.
 * Replace with actual implementation or delete if not needed.
 *
 * Example real scripts from other skills:
 * - asset-pipeline/scripts/asset-sheet-probe.mjs - Reports non-empty sprite frames
 * - pixel-snapper/scripts/pixel-snapper.mjs - Recovers a native pixel grid
 */

function main() {
  console.log("This is an example script for the ${skillName} skill");
  console.log("Replace this with actual functionality or delete this file");
}

main();
`;

// src/skill/init.ts
function titleCaseSkillName(skillName) {
  return skillName.split("-").map((word) => word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word).join(" ");
}
function initSkill(skillName, path, log) {
  const skillDir = join(resolve(path), skillName);
  if (existsSync(skillDir)) {
    log(`\u274C Error: Skill directory already exists: ${skillDir}`);
    return null;
  }
  const created = [];
  try {
    mkdirSync(skillDir, { recursive: true });
    log(`\u2705 Created skill directory: ${skillDir}`);
  } catch (error) {
    log(`\u274C Error creating directory: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  const skillTitle = titleCaseSkillName(skillName);
  try {
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_TEMPLATE(skillName, skillTitle));
    log("\u2705 Created SKILL.md");
    created.push("SKILL.md");
  } catch (error) {
    log(`\u274C Error creating SKILL.md: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  try {
    const scriptsDir = join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = join(scriptsDir, "example.mjs");
    writeFileSync(scriptPath, EXAMPLE_SCRIPT(skillName));
    chmodSync(scriptPath, 493);
    log("\u2705 Created scripts/example.mjs");
    created.push("scripts/example.mjs");
    const referencesDir = join(skillDir, "references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(join(referencesDir, "api_reference.md"), EXAMPLE_REFERENCE(skillTitle));
    log("\u2705 Created references/api_reference.md");
    created.push("references/api_reference.md");
    const assetsDir = join(skillDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "example_asset.txt"), EXAMPLE_ASSET);
    log("\u2705 Created assets/example_asset.txt");
    created.push("assets/example_asset.txt");
  } catch (error) {
    log(
      `\u274C Error creating resource directories: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
  return { dir: skillDir, created };
}

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize-factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/validate.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
var ALLOWED_PROPERTIES = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "compatibility",
  "metadata"
];
function validateSkill(skillPath) {
  const skillMd = join2(skillPath, "SKILL.md");
  if (!existsSync2(skillMd)) return { valid: false, message: "SKILL.md not found" };
  const content = readFileSync(skillMd, "utf8");
  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return { valid: false, message: "Invalid frontmatter format" };
  const frontmatterText = match[1];
  if (/^description:\s*[>|]-?\s*$/m.test(frontmatterText)) {
    return {
      valid: false,
      message: "Description must use an inline string value, not YAML folded/literal scalar (`>` or `|`)."
    };
  }
  for (const line of frontmatterText.split("\n")) {
    const match2 = /^([a-z-]+):\s+(?!["'|>])(.*)$/i.exec(line);
    if (match2 && match2[2].includes(": ")) {
      return {
        valid: false,
        message: `\`${match2[1]}\` contains ": " but is not quoted, which strict YAML reads as a nested mapping \u2014 the installer will skip this skill. Wrap the value in quotes.`
      };
    }
  }
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    return { valid: false, message: `Invalid YAML in frontmatter: ${detail}` };
  }
  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_PROPERTIES.includes(key)).sort();
  if (unexpected.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`
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
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`
      };
    }
    if (name.length > 64) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is 64 characters.`
      };
    }
  }
  const rawDescription = frontmatter.description;
  if (typeof rawDescription !== "string") {
    return {
      valid: false,
      message: `Description must be a string, got ${typeName(rawDescription)}`
    };
  }
  const description = rawDescription.trim();
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`
      };
    }
  }
  return { valid: true, message: "Skill is valid!" };
}
function typeName(value) {
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

// src/skill/zip.ts
import { deflateRawSync } from "node:zlib";
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable2[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function dosDateTime(date) {
  const time = Math.floor(date.getSeconds() / 2) & 31 | (date.getMinutes() & 63) << 5 | (date.getHours() & 31) << 11;
  const day = date.getDate() & 31 | (date.getMonth() + 1 & 15) << 5 | (Math.max(0, date.getFullYear() - 1980) & 127) << 9;
  return { time, date: day };
}
var FLAG_UTF8 = 2048;
function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : Buffer.from(entry.data);
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime ?? /* @__PURE__ */ new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(67324752, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, payload);
    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(33639248, 0);
    entryHeader.writeUInt16LE(20, 4);
    entryHeader.writeUInt16LE(20, 6);
    entryHeader.writeUInt16LE(FLAG_UTF8, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(payload.length, 20);
    entryHeader.writeUInt32LE(entry.data.length, 24);
    entryHeader.writeUInt16LE(nameBytes.length, 28);
    entryHeader.writeUInt16LE(0, 30);
    entryHeader.writeUInt16LE(0, 32);
    entryHeader.writeUInt16LE(0, 34);
    entryHeader.writeUInt16LE(0, 36);
    entryHeader.writeUInt32LE(420 << 16, 38);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, nameBytes);
    offset += header.length + nameBytes.length + payload.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}
export {
  analyzeSkillBody,
  createZip,
  generateSuggestions,
  initSkill,
  parseFrontmatter,
  validateSkill
};
