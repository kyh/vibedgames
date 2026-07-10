---
name: ask-me
description: "Interview the user relentlessly about the game they want to make until the idea is build-ready, resolving each branch of the design tree one question at a time. Use when the user has a fuzzy or one-line game idea and wants to flesh it out before building: 'grill me about my game', 'help me figure out what game to make', 'stress-test my game idea', 'interview me about the game', 'I want to make a game but I'm not sure what'. Not for when the user already knows what they want built — go straight to game-playbook."
---

# Grill the game idea

Interview the user relentlessly about every aspect of the game they want to
make until you reach a shared, build-ready understanding. Walk down each
branch of the design tree, resolving dependencies between decisions
one-by-one.

**Ask the questions one at a time, waiting for the answer before
continuing** — multiple questions at once is bewildering. For each question,
provide your recommended answer and why — the user should be able to say
"yes, that" and move on.

**Facts vs decisions**: if a *fact* can be found by exploring an existing
project or codebase, look it up instead of asking. The *decisions* are the
user's — put each one to them and wait; never answer your own question and
move on.

**Sharpen fuzzy terms as they appear.** When the user says "roguelike",
"combo", "level", "energy" — overloaded words — propose a precise meaning
and get agreement ("by 'roguelike' do you mean permadeath + procedural
runs, or just 'hard'?"). Pick one canonical name per concept and use it
consistently in the SPEC; later build sessions will mishandle synonyms.

**Stress-test answers with degenerate play.** When a loop or mechanic is
described, probe it with concrete hostile scenarios before accepting it:
what happens if the player stands still? Spams the one button? Hoards
instead of spends? Never takes the risky route? If the answer is "nothing
breaks, it's just boring," that's a finding — challenge the branch.

**Capture as you go.** Write each resolved branch into `design/SPEC.md`
the moment it settles, not in one batch at the end — a long interview that
dies mid-session should leave the decisions made so far on disk.

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

13. **The riskiest assumption.** Which single belief, if false, kills this
    game? Usually "the core verb is fun with zero goals attached." Agree on
    the cheapest test that answers it — for a browser game, a grayblock
    scene: core verb only, no art, no menus, no progression. Define the
    fun-confirmed signal behaviorally, in advance (unprompted "one more
    run", the player narrating what happened, "wait, what if I…") and a
    kill/pivot criterion — deciding now is what stops a dead core from
    getting decorated with features later.

## Exit

When no unresolved branches remain, finalize `design/SPEC.md` (create the
dir if needed; most of it should already exist from capture-as-you-go):
hook, references, loop, controls, win/lose, progression, MVP cut list,
art/audio direction, multiplayer decision, title/slug — plus the riskiest
assumption and its kill criterion, and the canonical term for each game
concept. Keep it to one page — it's a compass, not a plan.

**Do not start building until the user confirms the SPEC reflects a shared
understanding.**

The SPEC is now the foundation, not the finish line. Point the user at the
craft skills that turn a sound design into a game worth replaying, and pull
each in at its moment rather than dumping them all at once:

- **`design-lenses`** — pressure-test whether the idea is actually fun before
  building.
- **`game-feel`** + **`vfx`** — make movement and impact feel good.
- **`level-design`** + **`game-balance`** — shape the content and the
  difficulty curve.
- **`onboarding`** — the first 30 seconds and teaching without a manual.
- **`finish-it`** — hold scope to the MVP cut and actually ship.

If you reached this interview from a **`teach-me`** session, return to it: the
user builds the game themselves, lesson by lesson, with you guiding — don't
build it for them.
