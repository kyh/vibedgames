# Routing notes

A convention for making skill **relationships** legible — to a human reading the
descriptions, and as a prose hint to the agent. Used by the vibedgames skill
suite. This complements automatic composability (see `composability.md`); it does
not replace it.

> **Scope, honestly.** These are **human-readable cross-references written in
> consistent prose** — not a parsed format. Nothing in the codebase reads a
> `Routing:` clause; the agent treats it as ordinary description text. A small
> blind eval (6 prompts × no-routing / full / trimmed) found the clauses changed
> skill selection on **one** prompt — inserting the craft step into a full
> "build and ship" sequence — and that win traced to **one line**:
> `game-playbook`'s `sequences …` index. The per-skill edges did not measurably
> change routing on those prompts. So treat this as documentation hygiene with a
> single load-bearing element (the orchestrator's build-order index), not an
> agent-routing engine. Keep clauses short; don't over-invest.

## Why it exists

Automatic composability — the agent loading several skills at once purely from
their descriptions — is the right default for **orthogonal** skills that don't
know about each other. But the vibedgames skills are not orthogonal; they form a
**dependency stack**:

```
craft / taste        (game-feel, vfx, animation, level-design, onboarding)   ← judgment on top
        ▲ consumes the output of
workflow / pipeline  (pixel-art, animated-spritesheets, media-recipes)       ← procedures
        ▲ composes the verbs of
capability / CLI     (generate, deploy, fork)                                 ← raw tools
```

A spritesheet workflow *runs through* `generate`; its frames are then *refined
by* `animation`; the whole build is *orchestrated by* `game-playbook`. When those
relationships live only in ad-hoc prose ("see the pixel-art skill", "for feel go
to game-feel") the phrasing drifts. Writing them in a consistent vocabulary keeps
them readable and easy to keep in sync — most importantly the one that earns its
keep: the orchestrator's build-order index.

Routing clauses are *hints*, not imports — a skill must still be usable on its
own. They degrade gracefully: if a referenced skill isn't installed, the sentence
is still readable English.

## The convention

Append a single `Routing:` sentence to the **end** of the `description` field,
after the what/when/triggers. Clauses are semicolon-separated. Every clause is
optional — include only the edges that are true. Keep it to a phase plus one or
two edges; this is a signpost, not a sitemap.

```
Routing: <phase> phase; <edge>; <edge>.
```

### Phase (build-order position)

One of, in build order:

| phase      | meaning                                              | examples                         |
| ---------- | ---------------------------------------------------- | -------------------------------- |
| `meta`     | helps you build/choose, not part of one game's build | skill-creator, model-catalog, ask-me |
| `scaffold` | stand a project up                                   | phaser, threejs, fork            |
| `asset`    | make the art/audio/3D that goes in                   | pixel-art, animated-spritesheets, character-design |
| `loop`     | build the playable systems                           | phaser, threejs, game-balance    |
| `craft`    | make it feel good / look good / read well            | game-feel, vfx, animation, onboarding |
| `feature`  | add a bolt-on capability                             | multiplayer, gamepad             |
| `ship`     | verify, deploy, publish, finish                      | deploy, playwright, finish-it    |

A skill can legitimately span phases — join them with `+` (an engine is
`scaffold+loop`); otherwise name the one a user is most often in when they reach
for it. Two foundational kinds of skill use a **role token** in the phase slot
instead of a phase: `capability` (a raw CLI everything else runs through, e.g.
`generate`, `deploy`) and `orchestrator` (the playbook that sequences a whole
build).

### Edge verbs (a small, consistent set)

| clause                              | meaning                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| ``runs through `X` ``               | this skill executes via capability skill `X` (the layer below it)  |
| ``then `X` ``                       | the natural next step after this one in the build order            |
| ``refines output of `X` ``          | this skill takes `X`'s artifacts and improves them                 |
| ``deepens `X` ``                    | this is the detailed module behind a lighter skill `X`             |
| ``pairs with `X` ``                 | a sibling commonly used alongside this one (a lateral edge)        |
| ``consult `X` for <case>``          | read reference skill `X` for `<case>` — you don't execute through it |
| ``use `X` instead for <case>``      | disambiguation — `X` is the right call for `<case>`, not this skill |
| ``orchestrated by `X` ``            | a piece-skill that `X` (an orchestrator) sequences                 |

Backtick every skill name so it's easy to grep and visually distinct. Two
inverse forms exist for the hub skills: an **orchestrator** lists its pieces with
``sequences `A` → `B` → `C` `` and a **reference** lists its consumers with
``consulted by `A`, `B` ``. Notation: `` `A`/`B` `` = alternatives, `→` = build
order, `+` = a skill spanning two phases.

## Worked examples

```yaml
# capability — the foundational CLI everything generates through
description: "Use the `vg generate` CLI to ... Routing: capability; the generate-plugin skills all run through this."

# workflow — runs on a capability, hands to a craft skill
description: "Generate 2D pixel art game assets ... Routing: asset phase; runs through `generate`; then `animation` to make the frames move well, `phaser` to wire them in."

# craft — the deep module behind the playbook's checklist
description: "Deep game-feel and juice reference ... Routing: craft phase; deepens `game-playbook`."

# disambiguation between siblings
description: "Structured game-design critique ... Routing: craft phase; use `game-feel` instead for feel/juice tuning, not code-level bugs."

# the orchestrator itself (role token in the phase slot; sequences its pieces)
description: "The end-to-end recipe for building a GREAT browser game ... Routing: orchestrator; sequences `phaser`/`threejs` → `pixel-art` → `game-feel`/`vfx`/`animation` → `playwright` → `deploy`."
```

## Rules

- **Additive only.** Never edit the what/when/triggers to make room — the routing
  sentence goes at the very end. Trigger phrases are what get the skill loaded;
  routing only matters once it is.
- **Only true edges.** A wrong "then `X`" sends the agent down a dead path. If
  you're unsure an edge holds, omit it.
- **One edge, one type.** A directed edge `A → B` must read consistently from
  both ends: state it once, or use the forward/backward pair (`A` says
  ``then `B` ``, `B` says ``refines output of `A` ``). Never label the same pair
  directional on one side and ``pairs with`` (lateral) on the other — that hands
  the agent two contradictory models. Reserve ``pairs with`` for genuinely
  lateral siblings, reciprocated on both ends.
- **Keep it short.** Phase + one or two edges. If a skill needs a five-node map,
  that belongs in its SKILL.md body, not the description.
- **The orchestrator is the index.** Any piece-skill in a game build should be
  reachable from `game-playbook`. When you add a skill, add it to the playbook's
  recipe too, or it becomes an orphan the agent under-triggers.
