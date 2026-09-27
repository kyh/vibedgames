/**
 * Templates for a freshly scaffolded skill.
 *
 * Extracted verbatim from the Python initializer so the scaffold text is
 * unchanged, with one deliberate exception: the example script is now
 * `example.mjs` rather than `example.py`. A tool whose whole purpose is
 * seeding new skills should not seed a new Python dependency into every one
 * of them.
 */

export const SKILL_TEMPLATE = (skillName: string, skillTitle: string): string =>
  `---
name: ${skillName}
description: "TODO: one or two sentences, about 25 words — what it does, then the situation it is for. Name the neighbour skill it defers to if one exists. No trigger-phrase lists."
---

# ${skillTitle}

TODO: a paragraph — what this produces and when an agent should reach for it.

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

- \`references/<topic>.md\` — open when TODO.
- \`scripts/example.mjs\` — run to TODO; \`--help\` lists flags.

Delete any of references/, scripts/, assets/ this skill does not need.
`;

export const EXAMPLE_REFERENCE = (skillTitle: string): string =>
  `# Reference Documentation for ${skillTitle}

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

export const EXAMPLE_ASSET = `# Example Asset File

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

/**
 * The placeholder script a new skill is scaffolded with.
 *
 * The Python original seeded `example.py`; this seeds `example.mjs` so a
 * newly created skill starts with no Python dependency of its own.
 */
export const EXAMPLE_SCRIPT = (skillName: string): string =>
  `#!/usr/bin/env node
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
