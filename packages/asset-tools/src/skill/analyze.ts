/**
 * Heuristic quality analysis of a SKILL.md.
 *
 * Keyword and structure heuristics, not judgement. They measure the
 * properties that decide whether a skill loads when it should and costs as
 * little context as the task allows: a short, trigger-precise description; a
 * root document that routes to references and scripts instead of carrying
 * everything; concrete facts rather than itinerary; named traps; and a way
 * to verify the output without a human.
 */

import { isJsonString } from "../asset/json.js";
import type { YamlValue } from "./frontmatter.js";

export interface CategoryResult {
  category: string;
  score: number;
  feedback: string[];
}

/** Count regex matches without materialising them. */
const countMatches = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

const keywordsFound = (bodyLower: string, keywords: string[]): string[] =>
  keywords.filter((keyword) => bodyLower.includes(keyword));

export const DESCRIPTION_WORD_TARGET = 25;
export const DESCRIPTION_WORD_LIMIT = 40;
export const ROOT_LINE_TARGET = 150;

/**
 * The description is the whole basis for loading the skill, and every
 * skill's description shares one context budget — hosts truncate the long
 * ones. Short and specific scores; trigger-phrase lists and superlatives do
 * not.
 */
export const checkDescription = (description: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
  const words = description.split(/\s+/u).filter(Boolean).length;
  if (words === 0) {
    feedback.push("❌ No description");
    return { category: "Description", feedback, score };
  }
  if (words <= DESCRIPTION_WORD_TARGET) {
    score += 15;
    feedback.push(`✅ ${words} words`);
  } else if (words <= DESCRIPTION_WORD_LIMIT) {
    score += 8;
    feedback.push(`⚠️  ${words} words — aim for ${DESCRIPTION_WORD_TARGET}`);
  } else {
    feedback.push(
      `❌ ${words} words — over ${DESCRIPTION_WORD_LIMIT}; hosts truncate this and the agent sees less of every skill`,
    );
  }
  const quoted = countMatches(description, /["'“‘][^"'”’]{3,}["'”’]/gu);
  if (/\btriggers?\b/iu.test(description) || quoted >= 3) {
    feedback.push("❌ Reads as a trigger-phrase list — say the situation once instead");
  } else {
    score += 5;
  }
  if (
    /\b(?:foundational|comprehensive|powerful|advanced|enhanced|complete)\b/iu.test(description)
  ) {
    feedback.push("⚠️  Superlatives are pick-me energy, not a trigger");
  } else {
    score += 5;
  }
  return { category: "Description", feedback, score };
};

/**
 * The root is read on every load, so it should be a router: short, with the
 * moves that matter, pointing at references and scripts for depth.
 */
export const checkRouter = (
  body: string,
  hasReferences: boolean,
  hasScripts: boolean,
): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
  const lines = body.split("\n").length;
  if (lines <= ROOT_LINE_TARGET) {
    score += 12;
    feedback.push(`✅ ${lines} lines`);
  } else if (lines <= ROOT_LINE_TARGET * 2) {
    score += 6;
    feedback.push(`⚠️  ${lines} lines — move depth into references/`);
  } else {
    feedback.push(`❌ ${lines} lines — every load pays for all of it`);
  }
  const pointers = countMatches(body, /\b(?:references|scripts|assets)\/[\w./-]+/gu);
  if (hasReferences || hasScripts) {
    if (pointers >= 2) {
      score += 8;
      feedback.push(`✅ Points at ${pointers} supporting file(s)`);
    } else {
      feedback.push("❌ Has supporting files but the root barely points at them");
    }
  } else if (lines > ROOT_LINE_TARGET) {
    feedback.push("⚠️  No references/ or scripts/ to route to");
  } else {
    score += 8;
  }
  const headers = countMatches(body, /^#{2,3}\s+.+$/gmu);
  if (headers >= 3) {
    score += 5;
    feedback.push(`✅ ${headers} sections to navigate by`);
  } else {
    feedback.push("⚠️  Fewer than 3 sections — hard to skip what does not apply");
  }
  return { category: "Router", feedback, score };
};

/**
 * Concrete facts (numbers, commands, file paths, API names) are what a skill
 * adds over the model's own judgement. Long numbered itineraries are not.
 */
export const checkConcreteness = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
  const numbers = countMatches(body, /\b\d+(?:\.\d+)?\s?(?:ms|s|px|fps|%|kb|mb|hz|deg|°)\b/giu);
  const code = countMatches(body, /`[^`\n]+`/gu);
  if (numbers + code >= 15) {
    score += 15;
    feedback.push(`✅ ${numbers} measured values, ${code} code references`);
  } else if (numbers + code >= 5) {
    score += 8;
    feedback.push(
      `⚠️  ${numbers} measured values, ${code} code references — where are the numbers?`,
    );
  } else {
    feedback.push("❌ Little concrete content — prose the model already knows");
  }
  const steps = countMatches(body, /^\s*\d+\.\s+/gmu);
  if (steps > 12) {
    feedback.push(`⚠️  ${steps} numbered steps — itinerary; state the goal and the traps instead`);
  } else {
    score += 5;
  }
  return { category: "Concreteness", feedback, score };
};

/** Named traps are the cheapest way a skill saves a run. */
export const checkAntiPatterns = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
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
    "silently",
  ]);
  if (found.length >= 4) {
    score += 15;
    feedback.push(`✅ Names its traps: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 2) {
    score += 8;
    feedback.push(`⚠️  Some traps named: ${found.join(", ")}`);
  } else {
    feedback.push("❌ No traps named — what goes wrong when this is done naively?");
  }
  return { category: "Anti-Patterns", feedback, score };
};

/** A skill whose output cannot be checked headlessly ships broken output confidently. */
export const checkVerification = (body: string, hasScripts: boolean): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
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
    "review/",
  ]);
  if (found.length >= 3) {
    score += 12;
    feedback.push(`✅ Says how to prove the result: ${found.slice(0, 4).join(", ")}`);
  } else if (found.length >= 1) {
    score += 6;
    feedback.push(`⚠️  Verification mentioned once: ${found.join(", ")}`);
  } else {
    feedback.push("❌ No way to verify the output without a human");
  }
  if (hasScripts) {
    score += 3;
    feedback.push("✅ Ships scripts");
  }
  return { category: "Verification", feedback, score };
};

export interface Analysis {
  name: string;
  totalScore: number;
  categories: CategoryResult[];
}

export interface SupportFiles {
  hasReferences: boolean;
  hasScripts: boolean;
}

export const NO_SUPPORT_FILES: SupportFiles = { hasReferences: false, hasScripts: false };

export const analyzeSkillBody = (
  frontmatter: Record<string, YamlValue>,
  body: string,
  support: SupportFiles = NO_SUPPORT_FILES,
): Analysis => {
  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  const categories = [
    checkDescription(description),
    checkRouter(body, support.hasReferences, support.hasScripts),
    checkConcreteness(body),
    checkAntiPatterns(body),
    checkVerification(body, support.hasScripts),
  ];
  return {
    categories,
    name: isJsonString(frontmatter.name) ? frontmatter.name : "unknown",
    totalScore: categories.reduce((sum, c) => sum + c.score, 0),
  };
};
