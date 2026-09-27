# Before / after

Two rewrites taken from this repo's 2026-09 pass over all 35 skills, where
descriptions went from 2,380 words to 779 and the worst roots became routers.

## A description trimmed to its trigger

Before — 77 words, a trigger-phrase list, and it fires on anything with a
particle in it:

```yaml
description: "Real-time 2D VFX cookbook — layered explosions, hit sparks, muzzle flashes, trails, smoke, pickups, heals, shockwaves, weather — with particle parameter recipes, color/readability rules, and mobile-browser performance budgets, from Diablo's VFX talk, Riot's style guide, saint11, and the GDC VFX bootcamps. Use when: 'add effects', 'make the explosion better', 'hits need more impact' (visual side), 'add a trail/aura/sparkle', 'the effects look muddy/noisy', 'particles tank the framerate', or any Phaser particle emitter / blend mode / post-FX work."
```

After — 23 words: what it does, the medium it works in, nothing else:

```yaml
description: "Build real-time 2D effects in-engine — explosions, hit sparks, trails, smoke, pickups, shockwaves, weather — with particle recipes, readability rules and mobile budgets."
```

The sources, the quoted phrases and the "or any … work" clause all left.
They told the agent nothing about _when_ — only that the author was proud of
it. The neighbour boundary went into the neighbours instead: `animation` now
says "Generating frames is pixel-art / animated-spritesheets", and
`pixel-art` owns "effect sprites derived from generated video".

## A root cut to a router

Before — `skill-creator/SKILL.md` was 494 lines: a philosophy section, a
three-pillars table, an eight-step creation process with a full SKILL.md
template inlined, quality heuristics, pattern catalogues, and tool docs. Every
load paid for all of it, and the process steps told the agent things it would
do anyway.

After — 94 lines with five sections: why (two sentences), the description
contract, what a router root contains, where learnings go, the four-step
process, and one pointer line per reference and script. The pattern
catalogues (`references/anti-patterns.md`, `variation-patterns.md`,
`philosophy-patterns.md`, `composability.md`) were already there; the root had
been restating them.

What the analyzer said before and after:

```
before  Description 5 · Philosophy 40 · Anti-Patterns 35 · …   (old rubric)
after   Description 20 · Router 25 · Concreteness 20 · Anti-Patterns 15 · Verification 15 = 95
```

The rubric changed with it: it now scores the description length, whether the
root points at its supporting files, concrete facts over numbered steps,
named traps, and a way to verify — because those are what decide whether a
skill loads when it should and costs little to read.
