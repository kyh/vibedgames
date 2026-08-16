/**
 * Concrete upgrade suggestions for an existing skill.
 *
 * Where `analyze` scores a skill, this proposes the specific section that is
 * missing and shows what it should look like — so the output is something an
 * author can paste and edit rather than a number to chase.
 */

export type Suggestion = {
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  suggestion: string;
  example: string;
};

export function generateSuggestions(
  frontmatter: Record<string, unknown>,
  body: string,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
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
- What mental model helps make better decisions?`,
    });
  }

  // "avoid" only counts near the top, where a reader will actually meet it.
  if (!bodyLower.includes("anti-pattern") && !bodyLower.slice(0, 500).includes("avoid")) {
    suggestions.push({
      category: "Anti-Patterns",
      priority: "HIGH",
      suggestion: 'Add anti-patterns or "what to avoid" section',
      example: `## Anti-Patterns to Avoid

Common mistakes when [doing this task]:
- ❌ **Template trap**: Using rigid templates that constrain creativity
- ❌ **Context blindness**: Applying same approach regardless of situation
- ❌ **Over-specification**: Adding unnecessary constraints`,
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
- No two outputs should be identical unless requirements are identical`,
    });
  }

  if (!bodyLower.includes("extraordinary") && !bodyLower.includes("capable")) {
    suggestions.push({
      category: "Empowerment",
      priority: "LOW",
      suggestion: "Add empowering conclusion",
      example: `## Remember

Claude is capable of extraordinary work in this domain. These guidelines unlock that potential—they don't constrain it. Use judgment, adapt to context, and push boundaries when appropriate.`,
    });
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (description.length < 100) {
    suggestions.push({
      category: "Description",
      priority: "HIGH",
      suggestion: "Expand the description field in frontmatter",
      example: `Current: ${description}

Suggested: Add more detail about when to use this skill, what triggers it, and what tasks it helps with. Aim for 100-200 characters with specific use cases.`,
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
## Advanced Topics (optional)`,
    });
  }

  return suggestions;
}
