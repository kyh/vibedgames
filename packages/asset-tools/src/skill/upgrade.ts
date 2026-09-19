/**
 * Concrete upgrade suggestions for an existing skill.
 *
 * Where `analyze` scores a skill, this proposes the specific edit and shows
 * what it should look like — so the output is something an author can paste
 * and edit rather than a number to chase.
 */

import { isJsonString } from "../asset/json.js";
import {
  DESCRIPTION_WORD_LIMIT,
  DESCRIPTION_WORD_TARGET,
  NO_SUPPORT_FILES,
  ROOT_LINE_TARGET,
} from "./analyze.js";
import type { SupportFiles } from "./analyze.js";
import type { YamlValue } from "./frontmatter.js";

export interface Suggestion {
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  suggestion: string;
  example: string;
}

export const generateSuggestions = (
  frontmatter: Record<string, YamlValue>,
  body: string,
  support: SupportFiles = NO_SUPPORT_FILES,
): Suggestion[] => {
  const suggestions: Suggestion[] = [];
  const bodyLower = body.toLowerCase();

  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  const words = description.split(/\s+/u).filter(Boolean).length;
  if (words > DESCRIPTION_WORD_LIMIT || /\btriggers?\b/iu.test(description)) {
    suggestions.push({
      category: "Description",
      example: `Current (${words} words): ${description}

Rewrite as one or two sentences, about ${DESCRIPTION_WORD_TARGET} words: what it does, then the situation it is for, naming the neighbour it defers to if one exists. Drop trigger-phrase lists and superlatives — hosts truncate long descriptions and every skill shares that budget.`,
      priority: "HIGH",
      suggestion: "Shorten the description to a trigger-precise sentence",
    });
  }

  const lines = body.split("\n").length;
  if (lines > ROOT_LINE_TARGET) {
    suggestions.push({
      category: "Router",
      example: `SKILL.md is ${lines} lines; every load pays for all of it. Keep the root to: what and when, the three to six moves with their numbers and traps, one line per reference or script saying when to open it, and how to verify. Move the rest into references/<topic>.md and point at it:

- \`references/<topic>.md\` — open when <situation>.`,
      priority: "HIGH",
      suggestion: `Turn SKILL.md into a router under ${ROOT_LINE_TARGET} lines`,
    });
  } else if (
    (support.hasReferences || support.hasScripts) &&
    !/\b(?:references|scripts)\//u.test(body)
  ) {
    suggestions.push({
      category: "Router",
      example: `## Pointers

- \`references/<file>.md\` — open when <situation>.
- \`scripts/<file>.mjs\` — run to <do what>; \`--help\` lists flags.`,
      priority: "MEDIUM",
      suggestion: "Point the root at its references/ and scripts/",
    });
  }

  const steps = [...body.matchAll(/^\s*\d+\.\s+/gmu)].length;
  if (steps > 12) {
    suggestions.push({
      category: "Concreteness",
      example: `${steps} numbered steps read as an itinerary. Replace with the goal, the constraints, and the traps — keep the numbers, commands and file names, drop the order unless order matters.`,
      priority: "MEDIUM",
      suggestion: "Replace the step-by-step recipe with goal + constraints + traps",
    });
  }

  if (
    !bodyLower.includes("avoid") &&
    !bodyLower.includes("never") &&
    !bodyLower.includes("trap") &&
    !bodyLower.includes("pitfall")
  ) {
    suggestions.push({
      category: "Anti-Patterns",
      example: `## Traps

- <what a naive attempt does wrong>, because <mechanism>; do <this> instead.`,
      priority: "MEDIUM",
      suggestion: "Name the traps a naive attempt falls into",
    });
  }

  if (
    !bodyLower.includes("verif") &&
    !bodyLower.includes("harness") &&
    !bodyLower.includes("check") &&
    !bodyLower.includes("test")
  ) {
    suggestions.push({
      category: "Verification",
      example: `## Verify

<the script, harness or headless recipe that proves the output works — screenshots, a smoke check, a sim harness — so the agent never has to ask a human whether it worked>`,
      priority: "HIGH",
      suggestion: "Say how to prove the output works without a human",
    });
  }

  return suggestions;
};
