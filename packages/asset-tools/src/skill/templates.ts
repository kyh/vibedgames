/**
 * Templates for a freshly scaffolded skill.
 *
 * The scaffold's shape (SKILL.md plus placeholder references/, scripts/ and
 * assets/) follows `init_skill.py` from Anthropic's skill-creator (Apache-2.0;
 * see plugins/vibedgames/skills/skill-creator/references/credits.md). The text
 * is our own, written for game skills, and the example script is `example.mjs`
 * rather than `example.py`: a tool whose whole purpose is seeding new skills
 * should not seed a new Python dependency into every one of them.
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
  `# ${skillTitle} reference

Placeholder. Replace it with depth SKILL.md should not carry inline, or delete it.

A reference earns its place when only part of the work needs it: the full
contract of a tool, a long recipe, a catalogue of values. SKILL.md says when to
open it ("open when ...") and the agent skips it the rest of the time.

References in other skills of this plugin:
- threejs/references/gltf-loading-guide.md - loading, caching and normalising GLB models
- phaser/references/tilemaps.md - Tiled maps, layers and collision in Phaser
- playtest/references/scripted-playtest.md - driving a game through a scripted harness

## Shape

- Lead with the decision or the command, not the background.
- One topic per file; split a section out when only some tasks need it.
- Keep the numbers, flags and failure modes. Cut what any model already knows.
`;

export const EXAMPLE_ASSET = `# Example asset

Placeholder. Replace it with files the skill uses while it works, or delete it.

Assets are not read into context. A script consumes them, or the agent copies
them into the game: a starter scene, a palette, a font, a level template, sample
data for a script to chew on.

## Common asset types

- Starter code: a scene file, a config, a small project directory
- Art: .png, .svg, .ase palettes and reference sprites
- Fonts: .ttf, .woff2
- Data: .json, .csv level or tuning tables

Any file type works; this text file only marks the folder.
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
