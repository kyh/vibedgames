---
name: ask-me
description: "Interview the user relentlessly about the game they want to make until the idea is build-ready, resolving each branch of the design tree one question at a time. Use when the user has a fuzzy or one-line game idea and wants to flesh it out before building: 'grill me about my game', 'help me figure out what game to make', 'stress-test my game idea', 'interview me about the game', 'I want to make a game but I'm not sure what'. Not for when the user already knows what they want built — go straight to game-playbook. Routing: meta (pre-build); then `game-playbook` once the idea is build-ready."
---

# Grill the game idea

Interview the user relentlessly about every aspect of the game they want to
make until you reach a shared, build-ready understanding. Walk down each
branch of the design tree, resolving dependencies between decisions
one-by-one.

**Ask the questions one at a time.** For each question, provide your
recommended answer and why — the user should be able to say "yes, that" and
move on. If a question can be answered by exploring an existing project or
codebase, explore it instead of asking.

## The design tree

Resolve in dependency order — later answers hang off earlier ones. Skip
anything already answered; drill deeper wherever an answer is vague.

1. **The hook.** What is the player _doing_, and why is it fun? One sentence.
   Push until it's concrete: "dodge and counter in crowds" beats "an action
   game".
2. **References.** "X meets Y" — which existing games is this closest to, and
   what's the one twist that makes it not just a clone?
3. **Perspective and engine.** Top-down, side-on, isometric, 3D? This picks
   the engine (Phaser for 2D, Three.js for 3D) and constrains everything
   downstream.
4. **The 30-second loop.** Walk through exactly what the player does in a
   typical 30 seconds. If the answer has no tension or decision in it, that's
   a finding — challenge it: "where's the fun in this 30 seconds?"
5. **Input.** Keyboard-first? Mouse? Touch? Browser games live or die on
   instant, obvious controls.
6. **Win, lose, and session.** What ends a run? How long is one session?
   What pulls the player into "one more run"?
7. **Progression.** What's different in minute 10 vs minute 1? Difficulty
   curve, unlocks, escalation — or is it pure score-chase?
8. **Scope — the MVP cut.** What ships in the first deploy, and (more
   important) what's explicitly OUT? Push back hard here; the first version
   should be playable end-to-end in one sitting of work.
9. **Art direction.** Pixel art? Resolution/palette? Generated assets are
   cheap (`vg generate`), so ask for vibe and references, not asset lists.
10. **Audio.** Music vibe + the 3-5 sounds that matter most (hit, pickup,
    death, win).
11. **Multiplayer.** Single-player first is almost always the right call.
    If multiplayer: the platform is host-authoritative, last-write-wins —
    great for turn-based, room-based, and host-controlled games; wrong for
    twitch PvP. Say so if the idea fights the model.
12. **Title and slug.** It deploys to `{slug}.vibedgames.com` — pick both.

## Exit

When no unresolved branches remain, write the agreed design to
`design/SPEC.md` in the project (create the dir if needed): hook, references,
loop, controls, win/lose, progression, MVP cut list, art/audio direction,
multiplayer decision, title/slug. Keep it to one page — it's a compass, not a
plan.

Then hand off to the **game-playbook** skill to build it.
