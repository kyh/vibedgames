# Routing Grammar

A convention for making skill **relationships** legible to the agent, used by the
vibedgames skill suite. This is a complement to automatic composability (see
`composability.md`), not a replacement for it.

## Why this exists

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
by* `animation`; the whole build is *orchestrated by* `game-playbook`. Those are
real edges. When they live only in prose ("see the pixel-art skill", "for feel
go to game-feel") the phrasing is inconsistent and the agent has to re-derive the
build order every time. The routing grammar encodes the edges in a fixed
vocabulary the agent can walk reliably, and that a developer can grep and keep
from drifting.

This does **not** contradict "don't hard-depend on other skills." A skill must
still be usable on its own. Routing clauses are *hints* — "the natural next step
is X", "use Y instead for Z" — not imports. They degrade gracefully: if the
referenced skill isn't installed, the sentence is still readable English.

## The grammar

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
| `asset`    | make the art/audio/3D that goes in                   | pixel-art, animated-spritesheets, generate |
| `loop`     | build the playable systems                           | phaser, threejs, game-balance    |
| `craft`    | make it feel good / look good / read well            | game-feel, vfx, animation, onboarding |
| `feature`  | add a bolt-on capability                             | multiplayer, gamepad             |
| `ship`     | verify, deploy, publish, finish                      | deploy, playwright, finish-it    |

A skill can legitimately span phases (an engine is `scaffold`+`loop`); name the
one a user is most often in when they reach for it.

### Edge verbs (fixed lexicon)

| clause                              | meaning                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| ``runs through `X` ``               | this skill executes via capability skill `X` (the layer below it)  |
| ``then `X` ``                       | the natural next step after this one in the build order            |
| ``refines output of `X` ``          | this skill takes `X`'s artifacts and improves them                 |
| ``deepens `X` ``                    | this is the detailed module behind a lighter skill `X`             |
| ``use `X` instead for <case>``      | disambiguation — `X` is the right call for `<case>`, not this skill |
| ``orchestrated by `X` ``            | a piece-skill that `X` (an orchestrator) sequences                 |

Backtick every skill name so it's machine-greppable and visually distinct.

## Worked examples

```yaml
# capability — the foundational CLI everything generates through
description: "Use the `vg generate` CLI to ... Routing: capability; the generate-plugin skills all run through this."

# workflow — runs on a capability, hands to a craft skill
description: "Generate 2D pixel art game assets ... Routing: asset phase; runs through `generate`; then `animation` to make the frames move well, `phaser` to wire them in."

# craft — the deep module behind the playbook's checklist
description: "Deep game-feel and juice reference ... Routing: craft phase; deepens `game-playbook`."

# disambiguation between siblings
description: "Structured game-design critique ... Routing: craft phase; use `game-feel` instead for feel/juice tuning, `code review` for bugs."

# the orchestrator itself
description: "The end-to-end recipe for building a GREAT browser game ... Routing: orchestrator (scaffold→ship); sequences `phaser`/`threejs`, `pixel-art`, `game-feel`, `deploy`."
```

## Rules

- **Additive only.** Never edit the what/when/triggers to make room — the routing
  sentence goes at the very end. Trigger phrases are what get the skill loaded;
  routing only matters once it is.
- **Only true edges.** A wrong "then `X`" sends the agent down a dead path. If
  you're unsure an edge holds, omit it.
- **Keep it short.** Phase + one or two edges. If a skill needs a five-node map,
  that belongs in its SKILL.md body, not the description.
- **The orchestrator is the index.** Any piece-skill in a game build should be
  reachable from `game-playbook`. When you add a skill, add it to the playbook's
  recipe too, or it becomes an orphan the agent under-triggers.
