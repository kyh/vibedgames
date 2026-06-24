# Routing notes

How the vibedgames skills point at each other, and — honestly — how much that
matters. This complements automatic composability (see `composability.md`); it
does not replace it.

## The one thing that earns its place

The skills form a dependency stack — `generate` (capability) → `pixel-art`
(workflow) → `game-feel` (craft) → `deploy` (ship) — sequenced by the
`game-playbook` orchestrator. A blind A/B eval (6 prompts, fresh router agents
picking skills with vs. without relationship annotations) found that annotations
changed skill selection on **one** prompt: a full "build a game and ship it"
request, where the no-annotation run jumped from assets straight to deploy and
skipped the craft pass. That single win traced entirely to **one line** —
`game-playbook`'s description naming its build order:

```
… Build order it sequences: `phaser`/`threejs` → `pixel-art` →
`game-feel`/`vfx`/`animation` → `playwright` → `deploy`.
```

The orchestrator is selected first and routes the rest of the build from there,
so putting the build order **in its description** (not just its body) is the
thing that moves the agent.

## What we tried and dropped

An earlier version of this convention appended a `Routing:` clause (build phase +
typed edges like `runs through`, `then`, `pairs with`, `use X instead`) to all
~35 skill descriptions. The same eval found the other 34 clauses produced **no
measurable change** in routing — the base descriptions already disambiguate well
on their own (e.g. `design-lenses` already says "for feel go to game-feel";
`model-prompting` already says "use model-catalog instead"). So those clauses
were removed: they added words to the trigger-matching surface, needed a
consistency rulebook to keep both ends of each edge in agreement, and bought
nothing. Nothing in the codebase parses these annotations anyway — to the agent
they are ordinary description prose.

## The rule worth keeping

**The orchestrator is the index.** When you add a skill that's part of a game
build, add it to `game-playbook`'s build-order line (and its recipe body) rather
than annotating the new skill with edges pointing back. One home for the graph,
no cross-skill consistency to maintain. Keep individual descriptions focused on
their own triggers.

If a *specific* handoff later proves it changes routing in an eval, add that one
cross-reference — as plain prose, where it's needed. Don't reach for a blanket
per-skill convention again without evidence it moves behavior.
