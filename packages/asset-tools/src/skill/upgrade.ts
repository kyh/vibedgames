/**
 * Concrete upgrade suggestions for an existing skill.
 *
 * Where `analyze` scores a skill, this proposes the specific section that is
 * missing and shows what it should look like — so the output is something an
 * author can paste and edit rather than a number to chase.
 */

import { isJsonString } from "../asset/json.js";
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
): Suggestion[] => {
  const suggestions: Suggestion[] = [];
  const bodyLower = body.toLowerCase();

  if (!bodyLower.includes("philosophy") && !bodyLower.includes("principle")) {
    suggestions.push({
      category: "Philosophy",
      example: `## Core Philosophy

Before diving into procedures, understand the fundamental approach:
- What is the underlying philosophy guiding this domain?
- What questions should be asked before taking action?
- What mental model helps make better decisions?`,
      priority: "HIGH",
      suggestion: "Add a philosophy or principles section",
    });
  }

  // "avoid" only counts near the top, where a reader will actually meet it.
  if (!bodyLower.includes("anti-pattern") && !bodyLower.slice(0, 500).includes("avoid")) {
    suggestions.push({
      category: "Anti-Patterns",
      example: `## Anti-Patterns to Avoid

Common mistakes when [doing this task]:
- ❌ **Template trap**: Using rigid templates that constrain creativity
- ❌ **Context blindness**: Applying same approach regardless of situation
- ❌ **Over-specification**: Adding unnecessary constraints`,
      priority: "HIGH",
      suggestion: 'Add anti-patterns or "what to avoid" section',
    });
  }

  if (!bodyLower.includes("vary") && !bodyLower.includes("different")) {
    suggestions.push({
      category: "Variation",
      example: `## Encouraging Variation

**IMPORTANT**: Outputs should vary based on context. Avoid converging on "favorite" patterns:
- Adapt to the specific use case
- Consider different approaches for different scenarios
- No two outputs should be identical unless requirements are identical`,
      priority: "MEDIUM",
      suggestion: "Add explicit variation encouragement",
    });
  }

  if (!bodyLower.includes("extraordinary") && !bodyLower.includes("capable")) {
    suggestions.push({
      category: "Empowerment",
      example: `## Remember

Claude is capable of extraordinary work in this domain. These guidelines unlock that potential—they don't constrain it. Use judgment, adapt to context, and push boundaries when appropriate.`,
      priority: "LOW",
      suggestion: "Add empowering conclusion",
    });
  }

  const description = isJsonString(frontmatter.description) ? frontmatter.description : "";
  if (description.length < 100) {
    suggestions.push({
      category: "Description",
      example: `Current: ${description}

Suggested: Add more detail about when to use this skill, what triggers it, and what tasks it helps with. Aim for 100-200 characters with specific use cases.`,
      priority: "HIGH",
      suggestion: "Expand the description field in frontmatter",
    });
  }

  const sectionCount = body.split("\n##").length - 1;
  if (sectionCount < 3) {
    suggestions.push({
      category: "Organization",
      example: `Organize the skill into clear sections:
## Philosophy/Principles
## Core Guidelines
## Anti-Patterns
## Examples (optional)
## Advanced Topics (optional)`,
      priority: "MEDIUM",
      suggestion: "Add more section headers for better organization",
    });
  }

  return suggestions;
};
