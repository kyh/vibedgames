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
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

// src/asset/json.ts
var isJsonString = (value) => String(value) === value;
var isFiniteJsonNumber = (value) => Number.isFinite(value);

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  fps,
  loopable,
  recommendedFrames,
  selectionPolicy,
  timing
});
var ACTIONS = {
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle")
};

// src/skill/frontmatter.ts
var FrontmatterError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontmatterError";
  }
};
var stripComment = (line) => {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/u.test(line.charAt(i - 1)))) {
      return line.slice(0, i);
    }
  }
  return line;
};
var parseScalar = (raw) => {
  const text = raw.trim();
  if (text === "") {
    return "";
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2 || text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replaceAll(String.raw`\"`, '"').replaceAll("\\n", "\n") : body;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (text === "null" || text === "~") {
    return null;
  }
  if (/^-?\d+$/u.test(text)) {
    return Math.trunc(Number(text));
  }
  if (/^-?\d*\.\d+$/u.test(text)) {
    return Number(text);
  }
  return text;
};
var joinBlockScalar = (lines, style) => {
  const indent = lines.find((l) => l.trim())?.match(/^\s*/u)?.[0].length ?? 0;
  const stripped = lines.map((l) => l.slice(indent));
  const literal = style.startsWith("|");
  let text = "";
  if (literal) {
    text = stripped.join("\n");
  } else {
    for (const [i, line] of stripped.entries()) {
      if (i === 0) {
        text = line;
      } else if (line.trim() === "" || (stripped[i - 1] ?? "").trim() === "") {
        text += `
${line}`;
      } else {
        text += ` ${line}`;
      }
    }
  }
  text = text.replace(/\s+$/u, "");
  return style.endsWith("-") ? text : `${text}
`;
};
var NESTED_LINE_RE = /^\s+(?<key>[^:]+):\s*(?<value>.*)$/u;
var LINE_RE = /^(?<key>[^:]+):\s*(?<value>.*)$/u;
var BLOCK_SCALAR_RE = /^(?<style>[|>])(?<chomp>[+-]?)$/u;
var splitKeyValue = (re, line) => {
  const groups = re.exec(line)?.groups;
  if (!groups) {
    return null;
  }
  return { key: (groups.key ?? "").trim(), value: groups.value ?? "" };
};
var parseFrontmatter = (text) => {
  const out = {};
  let currentKey = null;
  let nested = null;
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] ?? "";
    const line = stripComment(rawLine);
    if (!line.trim()) {
      continue;
    }
    const indented = /^\s/u.test(line);
    if (indented) {
      if (!nested || currentKey === null) {
        throw new FrontmatterError(`unexpected indented line: ${rawLine.trim()}`);
      }
      const pair2 = splitKeyValue(NESTED_LINE_RE, line);
      if (!pair2) {
        throw new FrontmatterError(`could not parse nested line: ${rawLine.trim()}`);
      }
      nested[pair2.key] = parseScalar(pair2.value);
      continue;
    }
    const pair = splitKeyValue(LINE_RE, line);
    if (!pair) {
      throw new FrontmatterError(`could not parse line: ${rawLine.trim()}`);
    }
    const { key, value } = pair;
    const block = BLOCK_SCALAR_RE.exec(value.trim())?.groups;
    if (block) {
      const body = [];
      for (; ; ) {
        const next = rawLines[i + 1];
        if (next === void 0 || next.trim() !== "" && !/^\s/u.test(next)) {
          break;
        }
        body.push(next);
        i += 1;
      }
      while (body.at(-1)?.trim() === "") {
        body.pop();
      }
      currentKey = null;
      nested = null;
      out[key] = joinBlockScalar(body, `${block.style ?? ""}${block.chomp ?? ""}`);
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
};

// src/skill/analyze.ts
var countMatches = (text, pattern) => [...text.matchAll(pattern)].length;
var keywordsFound = (bodyLower, keywords) => keywords.filter((keyword) => bodyLower.includes(keyword));
var DESCRIPTION_WORD_TARGET = 25;
var DESCRIPTION_WORD_LIMIT = 40;
var ROOT_LINE_TARGET = 150;
var checkDescription = (description) => {
  let score = 0;
  const feedback = [];
  const words = description.split(/\s+/u).filter(Boolean).length;
  if (words === 0) {
    feedback.push("\u274C No description");
    return { category: "Description", feedback, score };
  }
  if (words <= DESCRIPTION_WORD_TARGET) {
    score += 15;
    feedback.push(`\u2705 ${words} words`);
  } else if (words <= DESCRIPTION_WORD_LIMIT) {
    score += 8;
    feedback.push(`\u26A0\uFE0F  ${words} words \u2014 aim for ${DESCRIPTION_WORD_TARGET}`);
  } else {
    feedback.push(
      `\u274C ${words} words \u2014 over ${DESCRIPTION_WORD_LIMIT}; hosts truncate this and the agent sees less of every skill`
    );
  }
  const quoted = countMatches(description, /["'“‘][^"'”’]{3,}["'”’]/gu);
  if (/\btriggers?\b/iu.test(description) || quoted >= 3) {
    feedback.push("\u274C Reads as a trigger-phrase list \u2014 say the situation once instead");
  } else {
    score += 5;
  }
  if (/\b(?:foundational|comprehensive|powerful|advanced|enhanced|complete)\b/iu.test(description)) {
    feedback.push("\u26A0\uFE0F  Superlatives are pick-me energy, not a trigger");
  } else {
    score += 5;
  }
  return { category: "Description", feedback, score };
};
var checkRouter = (body, hasReferences, hasScripts) => {
  let score = 0;
  const feedback = [];
  const lines = body.split("\n").length;
  if (lines <= ROOT_LINE_TARGET) {
    score += 12;
    feedback.push(`\u2705 ${lines} lines`);
  } else if (lines <= ROOT_LINE_TARGET * 2) {
    score += 6;
    feedback.push(`\u26A0\uFE0F  ${lines} lines \u2014 move depth into references/`);
  } else {
    feedback.push(`\u274C ${lines} lines \u2014 every load pays for all of it`);
  }
  const pointers = countMatches(body, /\b(?:references|scripts|assets)\/[\w./-]+/gu);
  if (hasReferences || hasScripts) {
    if (pointers >= 2) {
      score += 8;
      feedback.push(`\u2705 Points at ${pointers} supporting file(s)`);
    } else {
      feedback.push("\u274C Has supporting files but the root barely points at them");
    }
  } else if (lines > ROOT_LINE_TARGET) {
    feedback.push("\u26A0\uFE0F  No references/ or scripts/ to route to");
  } else {
    score += 8;
  }
  const headers = countMatches(body, /^#{2,3}\s+.+$/gmu);
  if (headers >= 3) {
    score += 5;
    feedback.push(`\u2705 ${headers} sections to navigate by`);
  } else {
    feedback.push("\u26A0\uFE0F  Fewer than 3 sections \u2014 hard to skip what does not apply");
  }
  return { category: "Router", feedback, score };
};
var checkConcreteness = (body) => {
  let score = 0;
  const feedback = [];
  const numbers = countMatches(body, /\b\d+(?:\.\d+)?\s?(?:ms|s|px|fps|%|kb|mb|hz|deg|°)\b/giu);
  const code = countMatches(body, /`[^`\n]+`/gu);
  if (numbers + code >= 15) {
    score += 15;
    feedback.push(`\u2705 ${numbers} measured values, ${code} code references`);
  } else if (numbers + code >= 5) {
    score += 8;
    feedback.push(
      `\u26A0\uFE0F  ${numbers} measured values, ${code} code references \u2014 where are the numbers?`
    );
  } else {
    feedback.push("\u274C Little concrete content \u2014 prose the model already knows");
  }
  const steps = countMatches(body, /^\s*\d+\.\s+/gmu);
  if (steps > 12) {
    feedback.push(`\u26A0\uFE0F  ${steps} numbered steps \u2014 itinerary; state the goal and the traps instead`);
  } else {
    score += 5;
  }
  return { category: "Concreteness", feedback, score };
};
var checkAntiPatterns = (body) => {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "avoid",
    "never",
    "don't",
    "do not",
    "anti-pattern",
    "mistake",
    "pitfall",
    "trap",
    "gotcha",
    "silently"
  ]);
  if (found.length >= 4) {
    score += 15;
    feedback.push(`\u2705 Names its traps: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 2) {
    score += 8;
    feedback.push(`\u26A0\uFE0F  Some traps named: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No traps named \u2014 what goes wrong when this is done naively?");
  }
  return { category: "Anti-Patterns", feedback, score };
};
var checkVerification = (body, hasScripts) => {
  let score = 0;
  const feedback = [];
  const found = keywordsFound(body.toLowerCase(), [
    "verify",
    "verification",
    "check",
    "harness",
    "headless",
    "screenshot",
    "test",
    "assert",
    "smoke",
    "review/"
  ]);
  if (found.length >= 3) {
    score += 12;
    feedback.push(`\u2705 Says how to prove the result: ${found.slice(0, 4).join(", ")}`);
  } else if (found.length >= 1) {
    score += 6;
    feedback.push(`\u26A0\uFE0F  Verification mentioned once: ${found.join(", ")}`);
  } else {
    feedback.push("\u274C No way to verify the output without a human");
  }
  if (hasScripts) {
    score += 3;
    feedback.push("\u2705 Ships scripts");
  }
  return { category: "Verification", feedback, score };
};
var NO_SUPPORT_FILES = { hasReferences: false, hasScripts: false };
var analyzeSkillBody = (frontmatter, body, support = NO_SUPPORT_FILES) => {
  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  const categories = [
    checkDescription(description),
    checkRouter(body, support.hasReferences, support.hasScripts),
    checkConcreteness(body),
    checkAntiPatterns(body),
    checkVerification(body, support.hasScripts)
  ];
  return {
    categories,
    name: isJsonString(frontmatter.name) ? frontmatter.name : "unknown",
    totalScore: categories.reduce((sum, c) => sum + c.score, 0)
  };
};

// src/skill/upgrade.ts
var generateSuggestions = (frontmatter, body, support = NO_SUPPORT_FILES) => {
  const suggestions = [];
  const bodyLower = body.toLowerCase();
  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  const words = description.split(/\s+/u).filter(Boolean).length;
  if (words > DESCRIPTION_WORD_LIMIT || /\btriggers?\b/iu.test(description)) {
    suggestions.push({
      category: "Description",
      example: `Current (${words} words): ${description}

Rewrite as one or two sentences, about ${DESCRIPTION_WORD_TARGET} words: what it does, then the situation it is for, naming the neighbour it defers to if one exists. Drop trigger-phrase lists and superlatives \u2014 hosts truncate long descriptions and every skill shares that budget.`,
      priority: "HIGH",
      suggestion: "Shorten the description to a trigger-precise sentence"
    });
  }
  const lines = body.split("\n").length;
  if (lines > ROOT_LINE_TARGET) {
    suggestions.push({
      category: "Router",
      example: `SKILL.md is ${lines} lines; every load pays for all of it. Keep the root to: what and when, the three to six moves with their numbers and traps, one line per reference or script saying when to open it, and how to verify. Move the rest into references/<topic>.md and point at it:

- \`references/<topic>.md\` \u2014 open when <situation>.`,
      priority: "HIGH",
      suggestion: `Turn SKILL.md into a router under ${ROOT_LINE_TARGET} lines`
    });
  } else if ((support.hasReferences || support.hasScripts) && !/\b(?:references|scripts)\//u.test(body)) {
    suggestions.push({
      category: "Router",
      example: `## Pointers

- \`references/<file>.md\` \u2014 open when <situation>.
- \`scripts/<file>.mjs\` \u2014 run to <do what>; \`--help\` lists flags.`,
      priority: "MEDIUM",
      suggestion: "Point the root at its references/ and scripts/"
    });
  }
  const steps = [...body.matchAll(/^\s*\d+\.\s+/gmu)].length;
  if (steps > 12) {
    suggestions.push({
      category: "Concreteness",
      example: `${steps} numbered steps read as an itinerary. Replace with the goal, the constraints, and the traps \u2014 keep the numbers, commands and file names, drop the order unless order matters.`,
      priority: "MEDIUM",
      suggestion: "Replace the step-by-step recipe with goal + constraints + traps"
    });
  }
  if (!bodyLower.includes("avoid") && !bodyLower.includes("never") && !bodyLower.includes("trap") && !bodyLower.includes("pitfall")) {
    suggestions.push({
      category: "Anti-Patterns",
      example: `## Traps

- <what a naive attempt does wrong>, because <mechanism>; do <this> instead.`,
      priority: "MEDIUM",
      suggestion: "Name the traps a naive attempt falls into"
    });
  }
  if (!bodyLower.includes("verif") && !bodyLower.includes("harness") && !bodyLower.includes("check") && !bodyLower.includes("test")) {
    suggestions.push({
      category: "Verification",
      example: `## Verify

<the script, harness or headless recipe that proves the output works \u2014 screenshots, a smoke check, a sim harness \u2014 so the agent never has to ask a human whether it worked>`,
      priority: "HIGH",
      suggestion: "Say how to prove the output works without a human"
    });
  }
  return suggestions;
};

// src/skill/init.ts
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// src/skill/templates.ts
var SKILL_TEMPLATE = (skillName, skillTitle) => `---
name: ${skillName}
description: "TODO: one or two sentences, about 25 words \u2014 what it does, then the situation it is for. Name the neighbour skill it defers to if one exists. No trigger-phrase lists."
---

# ${skillTitle}

TODO: a paragraph \u2014 what this produces and when an agent should reach for it.

## The moves

TODO: the three to six things the agent actually does, each with the numbers,
commands, file names and traps that matter. Concrete facts earn their place;
a numbered itinerary does not.

## Traps

- TODO: what a naive attempt gets wrong, why, and what to do instead.

## Verify

TODO: the script, harness or headless recipe that proves the output works
without a human.

## Pointers

- \`references/<topic>.md\` \u2014 open when TODO.
- \`scripts/example.mjs\` \u2014 run to TODO; \`--help\` lists flags.

Delete any of references/, scripts/, assets/ this skill does not need.
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
var titleCaseSkillName = (skillName) => skillName.split("-").map((word) => word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word).join(" ");
var initSkill = (skillName, parentDir, log) => {
  const skillDir = path.join(path.resolve(parentDir), skillName);
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
    writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_TEMPLATE(skillName, skillTitle));
    log("\u2705 Created SKILL.md");
    created.push("SKILL.md");
  } catch (error) {
    log(`\u274C Error creating SKILL.md: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  try {
    const scriptsDir = path.join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, "example.mjs");
    writeFileSync(scriptPath, EXAMPLE_SCRIPT(skillName));
    chmodSync(scriptPath, 493);
    log("\u2705 Created scripts/example.mjs");
    created.push("scripts/example.mjs");
    const referencesDir = path.join(skillDir, "references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(path.join(referencesDir, "api_reference.md"), EXAMPLE_REFERENCE(skillTitle));
    log("\u2705 Created references/api_reference.md");
    created.push("references/api_reference.md");
    const assetsDir = path.join(skillDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "example_asset.txt"), EXAMPLE_ASSET);
    log("\u2705 Created assets/example_asset.txt");
    created.push("assets/example_asset.txt");
  } catch (error) {
    log(
      `\u274C Error creating resource directories: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
  return { created, dir: skillDir };
};

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize-factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/validate.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import path2 from "node:path";
var ALLOWED_PROPERTIES = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "compatibility",
  "metadata"
];
var typeName = (value) => {
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
var UNQUOTED_VALUE_RE = /^(?<key>[a-z-]+):\s+(?!["'|>])(?<value>.*)$/iu;
var findUnquotedColon = (frontmatterText) => {
  for (const line of frontmatterText.split("\n")) {
    const groups = UNQUOTED_VALUE_RE.exec(line)?.groups;
    if (groups?.value?.includes(": ")) {
      return {
        message: `\`${groups.key}\` contains ": " but is not quoted, which strict YAML reads as a nested mapping \u2014 the installer will skip this skill. Wrap the value in quotes.`,
        valid: false
      };
    }
  }
  return null;
};
var validateName = (rawName) => {
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
      valid: false
    };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return {
      message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      valid: false
    };
  }
  if (name.length > 64) {
    return {
      message: `Name is too long (${name.length} characters). Maximum is 64 characters.`,
      valid: false
    };
  }
  return null;
};
var validateDescription = (rawDescription) => {
  if (!isJsonString(rawDescription)) {
    return {
      message: `Description must be a string, got ${typeName(rawDescription)}`,
      valid: false
    };
  }
  const description = rawDescription.trim();
  if (!description) {
    return null;
  }
  if (description.includes("<") || description.includes(">")) {
    return { message: "Description cannot contain angle brackets (< or >)", valid: false };
  }
  if (description.length > 1024) {
    return {
      message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      valid: false
    };
  }
  return null;
};
var validateSkill = (skillPath) => {
  const skillMd = path2.join(skillPath, "SKILL.md");
  if (!existsSync2(skillMd)) {
    return { message: "SKILL.md not found", valid: false };
  }
  const content = readFileSync(skillMd, "utf-8");
  if (!content.startsWith("---")) {
    return { message: "No YAML frontmatter found", valid: false };
  }
  const frontmatterText = /^---\n(?<front>[\s\S]*?)\n---/u.exec(content)?.groups?.front;
  if (frontmatterText === void 0) {
    return { message: "Invalid frontmatter format", valid: false };
  }
  if (/^description:\s*[>|]-?\s*$/mu.test(frontmatterText)) {
    return {
      message: "Description must use an inline string value, not YAML folded/literal scalar (`>` or `|`).",
      valid: false
    };
  }
  const unquoted = findUnquotedColon(frontmatterText);
  if (unquoted) {
    return unquoted;
  }
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(frontmatterText);
  } catch (error) {
    const detail = error instanceof FrontmatterError ? error.message : String(error);
    return { message: `Invalid YAML in frontmatter: ${detail}`, valid: false };
  }
  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_PROPERTIES.includes(key)).toSorted();
  if (unexpected.length > 0) {
    return {
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. Allowed properties are: ${[...ALLOWED_PROPERTIES].toSorted().join(", ")}`,
      valid: false
    };
  }
  if (!("name" in frontmatter)) {
    return { message: "Missing 'name' in frontmatter", valid: false };
  }
  if (!("description" in frontmatter)) {
    return { message: "Missing 'description' in frontmatter", valid: false };
  }
  return validateName(frontmatter.name) ?? validateDescription(frontmatter.description) ?? { message: "Skill is valid!", valid: true };
};

// src/skill/zip.ts
import { deflateRawSync } from "node:zlib";
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();
var crc32 = (bytes) => {
  let c = 4294967295;
  for (const byte of bytes) {
    c = (crcTable2[(c ^ byte) & 255] ?? 0) ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
};
var dosDateTime = (date) => {
  const time = Math.floor(date.getSeconds() / 2) & 31 | (date.getMinutes() & 63) << 5 | (date.getHours() & 31) << 11;
  const day = date.getDate() & 31 | (date.getMonth() + 1 & 15) << 5 | (Math.max(0, date.getFullYear() - 1980) & 127) << 9;
  return { date: day, time };
};
var FLAG_UTF8 = 2048;
var createZip = (entries) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
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
};
export {
  analyzeSkillBody,
  createZip,
  generateSuggestions,
  initSkill,
  parseFrontmatter,
  validateSkill
};
