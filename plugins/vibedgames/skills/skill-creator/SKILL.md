---
name: skill-creator
description: "Create or revise a skill in this repo: short trigger-precise descriptions, a router-style SKILL.md over references and scripts, quality checks."
---

# Skill Creator

A skill is a prompt the agent loads only for certain work, sometimes with
scripts. Two things make one good: it loads exactly when it should, and it
costs as little context as the task allows. Everything below serves those.

## Before writing one

- List `plugins/*/skills/` and check nothing already covers the job. Overlap
  is worse than a gap: two descriptions competing for the same request means
  the wrong one loads half the time. Extend the existing skill instead.
- Know who reads it. Skills in this repo run under whatever agent a
  contributor uses, so write for judgment, not for one model's quirks.

## The description is the contract

The description is all the agent sees when deciding whether to load a skill,
and every skill's description sits in context at once. Hosts truncate long
ones, so length is a shared budget, not a per-skill choice.

- One or two sentences, about 25 words: what it does, then the situation it
  is for. `Tune how a game feels — input forgiveness, hit stop, screen shake —
with concrete numbers.`
- Name the boundary when a neighbour exists: `Generating frames is pixel-art
/ animated-spritesheets.` `Not for building a game for them.`
- No lists of trigger phrases, no superlatives, no "the foundational skill".
  A description that fires on anything adjacent is a description that loads
  the wrong instructions.

## SKILL.md is a router

Reading a skill spends context and brings in guidance that may not apply.
Keep the root short — under ~150 lines — and let it point outward:

- **What and when**, in a paragraph.
- **The moves**: the three to six things the agent actually does, with the
  numbers, commands and traps that matter. Concrete facts (`snapshotArea`
  needs a `preserveDrawingBuffer`-free path; strip cells are 128px; hold the
  CDP client or coarse-pointer emulation is lost) earn their place. Itinerary
  does not: models handle order and nuance, so a numbered recipe that
  prescribes every step now constrains more than it helps.
- **Pointers**: one line per reference or script saying when to open it.
  `references/` carries depth (schemas, cookbooks, long workflows),
  `scripts/` carries deterministic or fragile work, `assets/` carries files
  that get copied rather than read.
- **Verification**: how the agent proves the output works without a human —
  a harness, a script, a headless recipe. A skill whose result cannot be
  checked will ship broken output confidently.

Skills with several distinct workflows make the root a pure index: a line
per workflow and where it lives, nothing else.

## Where learnings go

A durable lesson that changes what a user gets — a pitfall, a number, a
prompt rule, a harness trap — belongs in the skill that produced it: the
router if it is short, a reference if it needs room, the script's docstring
or `--help` if it is about running the script. Session memory is for the
agent's own continuity and never reaches the next reader. When you learn
something while using a skill, land it there in the same change.

## Bundled scripts

Resolve a skill's own files through `SKILL="${CLAUDE_SKILL_DIR}"` plus the
4-dir probe fallback (`.agents/skills .claude/skills ~/.agents/skills
~/.claude/skills`). Claude Code substitutes `${CLAUDE_SKILL_DIR}` in the
SKILL.md body — code fences included — for project, global and `--plugin-dir`
loads; `${CLAUDE_PLUGIN_ROOT}` stays literal outside plugins. A script in
another plugin's skill cannot resolve from a plugin install: tell the agent
to load the owning skill. Contract + test recipe: `references/composability.md`.

## Process

1. Write the description first; if it will not fit 25 words, the scope is
   wrong.
2. Draft the router. Move anything the agent would not need on every run
   into `references/`.
3. `node $SKILL/scripts/quick-validate.mjs <skill>` for frontmatter and
   structure, `node $SKILL/scripts/analyze-skill.mjs <skill>` for the quality
   read (`$SKILL` resolves per the snippet in any skill in this repo).
4. `pnpm dogfood` to sync `.claude/skills/`, commit the symlink.

## Pointers

- `references/anti-patterns.md` — the failure modes to check a draft against:
  template trap, checklist syndrome, generic guidance, context blindness,
  over-engineering.
- `references/variation-patterns.md` — when a skill produces creative output
  and keeps converging on the same result.
- `references/philosophy-patterns.md` — framing a domain's mental model when
  the skill must teach judgment rather than a procedure.
- `references/composability.md` — skills that hand off to each other; how to
  draw the boundary and who owns overlap.
- `references/workflows.md`, `references/output-patterns.md` — sequential and
  conditional workflow shapes; report templates.
- `examples/before-after.md` — two real rewrites from this repo: a description
  trimmed to its trigger, and a 494-line root cut to a router.
- `scripts/init-skill.mjs` scaffolds; `scripts/upgrade-skill.mjs` suggests
  edits for an existing skill; `scripts/package-skill.mjs` zips one for
  distribution.
