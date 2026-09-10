/**
 * Heuristic quality analysis of a SKILL.md body.
 *
 * These are keyword and structure heuristics, not judgement: they measure
 * whether a skill *establishes a philosophy*, *warns about anti-patterns*,
 * *encourages variation*, *is organised*, and *empowers rather than
 * constrains* — the properties that separate a skill which unlocks capability
 * from one that just narrows it.
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

export const checkPhilosophy = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
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
    "understand",
  ]);

  if (found.length >= 3) {
    score += 30;
    feedback.push(`✅ Philosophy indicators found: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 15;
    feedback.push(`⚠️  Some philosophy indicators found: ${found.join(", ")}`);
  } else {
    feedback.push("❌ No clear philosophical foundation detected");
  }

  // Guiding questions are a strong signal that the skill teaches reasoning
  // rather than dictating steps.
  const questions = countMatches(body, /\?[^\n]*/gu);
  if (questions >= 3) {
    score += 10;
    feedback.push(`✅ Contains ${questions} guiding questions`);
  } else if (questions >= 1) {
    score += 5;
    feedback.push(`⚠️  Contains ${questions} guiding question(s)`);
  }

  return { category: "Philosophy", feedback, score };
};

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
    "common pitfall",
    "warning",
    "incorrect",
    "wrong way",
  ]);

  if (found.length >= 5) {
    score += 25;
    feedback.push(`✅ Strong anti-pattern guidance: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 2) {
    score += 12;
    feedback.push(`⚠️  Some anti-pattern guidance: ${found.join(", ")}`);
  } else {
    feedback.push("❌ No explicit anti-pattern warnings");
  }

  // Capitalised warnings, which read as hard rules rather than suggestions.
  const strong = countMatches(body, /\b(?:NEVER|DO NOT|DON'T)\b/gu);
  if (strong > 0) {
    score += 10;
    feedback.push(`✅ Contains ${strong} strong warning(s)`);
  }

  return { category: "Anti-Patterns", feedback, score };
};

export const checkVariation = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
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
    "not the same",
  ]);

  if (found.length >= 3) {
    score += 20;
    feedback.push(`✅ Variation encouraged: ${found.slice(0, 5).join(", ")}`);
  } else if (found.length >= 1) {
    score += 10;
    feedback.push(`⚠️  Some variation mentioned: ${found.join(", ")}`);
  } else {
    feedback.push("❌ No explicit variation encouragement");
  }

  const templateWarnings = countMatches(
    bodyLower,
    /(?:template|repetitive|generic|cookie-cutter|converge)/gu,
  );
  if (templateWarnings > 0) {
    score += 10;
    feedback.push(`✅ Warns against generic patterns (${templateWarnings} mentions)`);
  }

  return { category: "Variation", feedback, score };
};

export const checkOrganization = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];

  const headers = countMatches(body, /^#+\s+.+$/gmu);
  if (headers >= 5) {
    score += 10;
    feedback.push(`✅ Well-structured with ${headers} sections`);
  } else if (headers >= 2) {
    score += 5;
    feedback.push(`⚠️  Has ${headers} sections`);
  } else {
    feedback.push("❌ Lacks clear organization");
  }

  const lists = countMatches(body, /^\s*[-*]\s+/gmu);
  if (lists >= 10) {
    score += 5;
    feedback.push(`✅ Contains ${lists} list items (actionable)`);
  }

  return { category: "Organization", feedback, score };
};

export const checkEmpowerment = (body: string): CategoryResult => {
  let score = 0;
  const feedback: string[] = [];
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
    "explore",
  ]);

  if (found.length >= 3) {
    score += 10;
    feedback.push(`✅ Empowering tone: ${found.join(", ")}`);
  } else if (found.length >= 1) {
    score += 5;
    feedback.push(`⚠️  Some empowering language: ${found.join(", ")}`);
  }

  // A wall of hard constraints suggests the skill is boxing the model in
  // rather than equipping it, so past a threshold this costs points.
  const constraints = keywordsFound(bodyLower, ["must", "always", "required", "mandatory"]);
  if (constraints.length > 20) {
    score -= 5;
    feedback.push(`⚠️  Many rigid constraints (${constraints.length} instances)`);
  }

  return { category: "Empowerment", feedback, score };
};

export interface Analysis {
  name: string;
  totalScore: number;
  categories: CategoryResult[];
}

export const analyzeSkillBody = (
  frontmatter: Record<string, YamlValue>,
  body: string,
): Analysis => {
  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  const categories: CategoryResult[] = [
    description.length > 50
      ? { category: "Description", feedback: ["✅ Comprehensive description"], score: 5 }
      : { category: "Description", feedback: ["❌ Description too brief"], score: 0 },
    checkPhilosophy(body),
    checkAntiPatterns(body),
    checkVariation(body),
    checkOrganization(body),
    checkEmpowerment(body),
  ];

  return {
    categories,
    name: isJsonString(frontmatter.name) ? frontmatter.name : "unknown",
    totalScore: categories.reduce((sum, c) => sum + c.score, 0),
  };
};
