---
name: design-lenses
description: "Structured game-design critique: review a game through Schell's design lenses and the MDA framework, producing severity-ranked findings with concrete fixes. Use when the user asks 'is my game fun?', 'review my game design', 'why is it boring?', 'critique this game', 'what's missing?', 'how do I make it better?' (design-level, not bug-level), or before shipping as a design QA pass. For feel/juice tuning go to game-feel; for bugs use code review."
---

# Design lens review

A lens is a viewpoint plus questions, not a rule (Schell). This skill runs a
battery of lenses against a game and outputs findings an agent can implement.
The defining failure of prompt-built games: mechanically correct, sensorially
and emotionally dead. The lenses find where.

## Procedure

1. **Play first, cold.** Load like a first-time visitor. Record: time to
   first input, time to first win/lose feedback, what you understood without
   instructions, where you got bored. Play twice — once naive, once trying to
   break it (spam inputs, resize, lose on purpose, idle).
2. **Write the MDA sentence**: "This game wants the player to feel X via
   dynamic Y produced by mechanics Z." Can't write it? That's finding #1 —
   no essential experience. Then write the loop contract: "player does
   [verb] to achieve [objective] while [pressure] creates risk; success →
   [reward], failure → [cost/retry]". Any bracket you can't fill is a
   finding too.
3. **Run the rejection gates** (below). Each failed gate is an automatic
   `blocker` — no lens needed.
4. **Pick 8–12 lenses.** Always: Essential Experience, Fun, Feedback,
   Juiciness, Accessibility. Add by genre (Skill vs Chance for arcade,
   Curiosity for puzzle, the Toy for sandbox/physics).
5. **Answer with evidence** — a timestamp, a code path, a missing sound —
   never vibes.
6. **Severity**: `blocker` (player quits or never understands), `major`
   (understood but flat), `minor` (polish), `idea` (opportunity).
7. **Findings as lens → evidence → fix**, fixes concrete ("80ms hit-stop +
   4px shake on collision", not "juicier"). Order: blockers, then cheapest
   major wins (audio + shake + score popups = highest fun-per-line).
8. **Re-play after fixes**, re-asking only the failed lenses and gates.

## Rejection gates

Binary go/no-go tests, self-applied in active play before claiming a game is
fun. Any "true" = automatic blocker; fix or iterate before polishing:

- The first 30 seconds lack a real decision.
- The player can ignore the main mechanic and still progress.
- The objective is unclear without reading source code or instructions.
- Failure arrives before the player can understand why.
- Challenge is only "more things", never better combinations.
- Rewards change nothing — not strategy, score, progression, or feel.
- The space is decorative and shapes no decisions.
- The game is fun only in the designer's explanation, not in active play.

## The lens battery

(All lenses Schell unless noted; questions paraphrased. "Smell" = the
browser-game failure mode.)

**Experience**

- **Essential Experience** — what experience should this create; does every
  system serve it? _Smell: a feature list, not a game about something._
- **Emotion** — what should the player feel; what's the arc of a 60s session?
  _Smell: second 10 feels identical to second 100; death has no sting._
- **Fun** — which parts are fun in themselves? Is failure fun? _Smell: the
  core verb is a chore — in a 2-minute game the verb IS the game._
- **Surprise** — what subverts expectation; rare events, escalation beats?
  _Smell: run two has seen 100% of the content._
- **Curiosity** — what questions live in the player's mind ("what's at 100
  points?")? _Smell: nothing teased, no visible next milestone._
- **The Toy** — strip the goals: is it fun to merely fiddle with? _Smell:
  movement functional but dead; nobody would touch it without a score._
- **Pleasure** (pairs with MDA aesthetics) — which pleasures exist
  (sensation, anticipation, triumph, destruction); which genre-expected ones
  are missing? _Smell: mono-pleasure; no audio at all is the #1 gap._

**Mechanics & structure**

- **Elemental Tetrad** — mechanics, story/theme, aesthetics, tech: each
  pulling weight, in harmony? _Smell: solid mechanics in placeholder art, or
  gorgeous art over a hollow loop._
- **Unification** — what's the theme; what fights it? _Smell: prompt-collage
  — pirate ship, neon UI, fantasy SFX, sci-fi enemies._
- **Problem Solving** — what problems does play pose; do new ones generate
  each run? _Smell: optimal strategy found in 30s, never changes._
- **Goals** — concrete, achievable, layered (next 5s / session / meta)?
  _Smell: "now what?" at spawn; one flat goal._
- **Meaningful Choices** — do choices matter; any dominant strategy? _Smell:
  three weapons, one strictly best; upgrades the player can't perceive._
- **Simplicity/Complexity** — emergent complexity from simple rules, or
  rulebook bloat? _Smell: six mechanics used once each. One verb deep beats
  five shallow._

**Balance & challenge**

- **Flow** (after Csikszentmihalyi) — does challenge track growing skill?
  _Smell: difficulty is a constant, not a function of time/score._
- **Challenge** — right for a first-timer; can experts self-select harder
  play? _Smell: novice and expert get the identical experience._
- **Skill vs Chance** — does randomness create drama or injustice? _Smell:
  off-screen spawn deaths; or zero variance, every run identical._
- **Reward** — varied, well-timed, perceptible the instant earned? _Smell:
  points silently increment in a corner._
- **Punishment** — every failure fair and preventable; retry instant?
  _Smell: death → 3 clicks to retry. Target one keypress, <2s._

**Feedback & feel**

- **Feedback** — for every action, what does the game say back, how fast
  (<100ms core verbs)? Status always glanceable? _Smell: "did that work?"
  moments._
- **Juiciness** (popularized by Jonasson/Purho) — cascading feedback from
  minimal input; does it feel alive? _Smell: linear motion, vanishing
  sprites, silent UI. Hand findings to `game-feel`._
- **Visible Progress** — advancement visible within a run and across runs?
  _Smell: no localStorage best score, no end-of-run stats, no replay hook._

**Accessibility & context**

- **Accessibility** — cold player sees how to begin in seconds, no manual?
  _Smell: wall-of-text instructions; first 5 seconds kill you while you hunt
  for the keys._
- **The Player** — who actually plays this; designed for them or the
  designer? _Smell: twitch platformer aimed at casual link-clickers._
- **The Venue** — a browser tab: interruptible, sound-off default, resize,
  touch AND keyboard, played at work. _Smell: runs while tab is blurred,
  audio never recovers post-gesture, breaks at non-16:9._
- **Time** — is session length right; natural stop/re-entry points? _Smell:
  runs that mathematically never end, or 8-second runs with no arc._

## MDA quick reference

Mechanics (authored rules) → Dynamics (runtime behavior) → Aesthetics (felt
emotion). Designers build M→A; players experience A→M — review from the
player's side. Eight aesthetics: Sensation, Fantasy, Narrative, Challenge,
Fellowship, Discovery, Expression, Submission. Trace every aesthetic failure
back to the mechanic causing it: "no tension (A) because no near-misses (D)
because hitboxes too forgiving and speed never ramps (M)" — that lands as an
implementable change.

**Koster cross-check** (_A Theory of Fun_): fun is pattern-learning; mastered
= boring. What is the player still learning at minute 1, 3, 5? "Nothing" by
minute 1 = no legs, regardless of polish.

Related skills: `game-feel` (implements Juiciness/Feedback findings),
`onboarding` (implements Accessibility/Flow findings), `game-balance`
(implements Choices/Reward findings), `game-playbook` (the build recipe).
