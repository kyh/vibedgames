---
name: design-lenses
description: "Structured game-design critique: review a game through Schell's design lenses and the MDA framework, producing severity-ranked findings with concrete fixes. Use when the user asks 'is my game fun?', 'review my game design', 'why is it boring?', 'critique this game', 'what's missing?', 'how do I make it better?' (design-level, not bug-level), or before shipping as a design QA pass. For feel/juice tuning go to game-feel; for bugs use code review."
---

# Design lens review

A lens is a viewpoint plus questions, not a rule (Jesse Schell, *The Art of
Game Design*). This skill runs a battery of lenses against a game and outputs
findings an agent can implement. The defining failure of prompt-built games:
mechanically correct, sensorially and emotionally dead. The lenses find where.

## Procedure

1. **Play first, cold.** Load like a first-time visitor. Record: time to
   first input, time to first win/lose feedback, what you understood without
   instructions, where you got bored. Play twice — once naive, once trying to
   break it (spam inputs, resize, lose on purpose, idle).
2. **Write the MDA sentence**: "This game wants the player to feel X via
   dynamic Y produced by mechanics Z." Can't write it? That's finding #1 —
   no essential experience.
3. **Pick 8–12 lenses.** Always: Essential Experience, Fun, Feedback,
   Juiciness, Accessibility. Add by genre (Skill vs Chance for arcade,
   Curiosity for puzzle, the Toy for sandbox/physics).
4. **Answer with evidence** — a timestamp, a code path, a missing sound —
   never vibes.
5. **Severity**: `blocker` (player quits or never understands), `major`
   (understood but flat), `minor` (polish), `idea` (opportunity).
6. **Findings as lens → evidence → fix**, fixes concrete ("80ms hit-stop +
   4px shake on collision", not "juicier"). Order: blockers, then cheapest
   major wins (audio + shake + score popups = highest fun-per-line).
7. **Re-play after fixes**, re-asking only the failed lenses.

## The lens battery

(All lenses Schell unless noted; questions paraphrased. "Smell" = the
browser-game failure mode.)

**Experience**
- **Essential Experience** — what experience should this create; does every
  system serve it? *Smell: a feature list, not a game about something.*
- **Emotion** — what should the player feel; what's the arc of a 60s session?
  *Smell: second 10 feels identical to second 100; death has no sting.*
- **Fun** — which parts are fun in themselves? Is failure fun? *Smell: the
  core verb is a chore — in a 2-minute game the verb IS the game.*
- **Surprise** — what subverts expectation; rare events, escalation beats?
  *Smell: run two has seen 100% of the content.*
- **Curiosity** — what questions live in the player's mind ("what's at 100
  points?")? *Smell: nothing teased, no visible next milestone.*
- **The Toy** — strip the goals: is it fun to merely fiddle with? *Smell:
  movement functional but dead; nobody would touch it without a score.*
- **Pleasure** (pairs with MDA aesthetics) — which pleasures exist
  (sensation, anticipation, triumph, destruction); which genre-expected ones
  are missing? *Smell: mono-pleasure; no audio at all is the #1 gap.*

**Mechanics & structure**
- **Elemental Tetrad** — mechanics, story/theme, aesthetics, tech: each
  pulling weight, in harmony? *Smell: solid mechanics in placeholder art, or
  gorgeous art over a hollow loop.*
- **Unification** — what's the theme; what fights it? *Smell: prompt-collage
  — pirate ship, neon UI, fantasy SFX, sci-fi enemies.*
- **Problem Solving** — what problems does play pose; do new ones generate
  each run? *Smell: optimal strategy found in 30s, never changes.*
- **Goals** — concrete, achievable, layered (next 5s / session / meta)?
  *Smell: "now what?" at spawn; one flat goal.*
- **Meaningful Choices** — do choices matter; any dominant strategy? *Smell:
  three weapons, one strictly best; upgrades the player can't perceive.*
- **Simplicity/Complexity** — emergent complexity from simple rules, or
  rulebook bloat? *Smell: six mechanics used once each. One verb deep beats
  five shallow.*

**Balance & challenge**
- **Flow** (after Csikszentmihalyi) — does challenge track growing skill?
  *Smell: difficulty is a constant, not a function of time/score.*
- **Challenge** — right for a first-timer; can experts self-select harder
  play? *Smell: novice and expert get the identical experience.*
- **Skill vs Chance** — does randomness create drama or injustice? *Smell:
  off-screen spawn deaths; or zero variance, every run identical.*
- **Reward** — varied, well-timed, perceptible the instant earned? *Smell:
  points silently increment in a corner.*
- **Punishment** — every failure fair and preventable; retry instant?
  *Smell: death → 3 clicks to retry. Target one keypress, <2s.*

**Feedback & feel**
- **Feedback** — for every action, what does the game say back, how fast
  (<100ms core verbs)? Status always glanceable? *Smell: "did that work?"
  moments.*
- **Juiciness** (popularized by Jonasson/Purho) — cascading feedback from
  minimal input; does it feel alive? *Smell: linear motion, vanishing
  sprites, silent UI. Hand findings to `game-feel`.*
- **Visible Progress** — advancement visible within a run and across runs?
  *Smell: no localStorage best score, no end-of-run stats, no replay hook.*

**Accessibility & context**
- **Accessibility** — cold player sees how to begin in seconds, no manual?
  *Smell: wall-of-text instructions; first 5 seconds kill you while you hunt
  for the keys.*
- **The Player** — who actually plays this; designed for them or the
  designer? *Smell: twitch platformer aimed at casual link-clickers.*
- **The Venue** — a browser tab: interruptible, sound-off default, resize,
  touch AND keyboard, played at work. *Smell: runs while tab is blurred,
  audio never recovers post-gesture, breaks at non-16:9.*
- **Time** — is session length right; natural stop/re-entry points? *Smell:
  runs that mathematically never end, or 8-second runs with no arc.*

## MDA quick reference

(Hunicke/LeBlanc/Zubek, 2004 — users.cs.northwestern.edu/~hunicke/MDA.pdf)

Mechanics (authored rules) → Dynamics (runtime behavior) → Aesthetics (felt
emotion). Designers build M→A; players experience A→M — review from the
player's side. Eight aesthetics: Sensation, Fantasy, Narrative, Challenge,
Fellowship, Discovery, Expression, Submission. Trace every aesthetic failure
back to the mechanic causing it: "no tension (A) because no near-misses (D)
because hitboxes too forgiving and speed never ramps (M)" — that lands as an
implementable change.

**Koster cross-check** (*A Theory of Fun*): fun is pattern-learning; mastered
= boring. What is the player still learning at minute 1, 3, 5? "Nothing" by
minute 1 = no legs, regardless of polish.

## Sources

- Schell, *The Art of Game Design: A Book of Lenses* — official deck:
  deck.artofgamedesign.com
- MDA paper — users.cs.northwestern.edu/~hunicke/MDA.pdf
- Koster, *A Theory of Fun* — theoryoffun.com

Related skills: `game-feel` (implements Juiciness/Feedback findings),
`onboarding` (implements Accessibility/Flow findings), `game-balance`
(implements Choices/Reward findings), `game-playbook` (the build recipe).
