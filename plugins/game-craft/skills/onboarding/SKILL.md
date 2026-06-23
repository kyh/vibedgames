---
name: onboarding
description: "First-30-seconds design, invisible tutorials, difficulty curves, failure/retry loops and assist modes for link-shared browser games — distilled from George Fan's PvZ tutorial rules, Jenova Chen's flow thesis, Koster's Theory of Fun, Juul's Art of Failure, and Celeste's Assist Mode. Use when: 'players don't get it', 'people quit immediately', 'does it need a tutorial?', 'too hard/too easy', 'tune the difficulty', 'make the start better', 'add an easy mode', or auditing a game's first minute before shipping. Routing: craft phase; pairs with `design-lenses`/`finish-it`; then `deploy`."
---

# Onboarding & difficulty

A vibedgames player arrives cold from a link, mid-conversation, with seconds
of patience. The first session is the whole funnel. Fun is learning (Koster):
the game lives while there's a pattern left to master, and difficulty must
rise with skill to stay in the flow channel (Chen, after Csikszentmihalyi).

## The first 30 seconds

- **Time-to-first-input < 5s.** No splash chain, no settings, no mode select.
- **Time-to-core-verb < 30s.** The player performs the signature verb (jump,
  shoot, plant) for real, with consequences, in the first half-minute.
- **One input to start** — "press any key / tap" over a live game scene.
  Show the actual game behind the title (attract mode), not a static logo.
- **First input produces a juicy result**: sound + motion + particles. The
  brain needs proof inputs matter before it will learn the pattern.
- **Goal in one sentence or zero**: "Survive." "Reach the flag."
- **Detect input device**: show touch hints to touch users, key hints to
  keyboard users — never a scheme the device can't use. If the core input is
  exotic (webcam, gamepad, mic), hint it explicitly and ship a plain
  mouse/keyboard fallback that's announced, not silent.
- **Browser permission prompts are modals.** Camera/mic/motion requests are
  the most common cold-open modal in browser games — make them opt-in behind
  a button, or defer until after first play. Never fire `getUserMedia` on
  mount.

## Teaching without a tutorial (George Fan's PvZ rules)

- **Doing > reading.** Never explain in text what a situation can force the
  player to discover once. Gate progress behind doing it once — done = taught.
- **≤ 8 words on screen at a time.** If an instruction needs more, redesign
  the situation, not the sentence.
- **Safe first exposure** (Half-Life 2 pattern): observe the hazard eat a
  barrel before dodging it yourself.
- **Ramp: teach → repeat with one twist → combine.** Never two new ideas at
  once; roughly one new element per level.
- **Objects self-describe**: appearance telegraphs function; piggyback on
  real-world knowledge (red = damage, coins = money, arrows = direction).
- **Hints are adaptive, not up-front**: "Try planting further left!" only
  after the relevant failure. No modal popups that pause play.
- **Bias the first decision**: make the correct opening move the cheap,
  shiny, obvious one (Fan made sunflowers cheap and sparkly).
- **Never label anything "Tutorial".**

## Difficulty curve

- **Start below the floor**: the first challenge is nearly unfailable — it
  teaches the verb and pays out a win.
- **Sawtooth, not ramp**: spikes then recovery valleys; mastery registers in
  the valleys. (Shape details in `level-design`.)
- **Re-test old skills while teaching new ones** — that combination is where
  the fun lives (Koster).
- **Embed difficulty choice in play** (Chen's flOw): risk/reward verbs — dive
  deeper, take the shortcut, bank or gamble — beat an Easy/Normal/Hard menu.
  Optional hard routes + collectibles let novice and expert share one build.
- **Hidden mercy after repeated failure** (Crash Bandicoot pattern): after
  3–5 consecutive deaths at one spot, silently soften — extra checkpoint,
  slower hazard. Never announce it.

## Failure & retry

"Death" means any failure event — a conceded point, a wiped wave, a failed
puzzle attempt all follow the same rules.

- **Death → retry: one input, < 2 seconds.** No confirmation dialogs, no
  unskippable death animations, no score screens between the player and the
  retry (Celeste/Super Meat Boy convention).
- **Failure must be legible** (Juul): the player answers "what killed me?"
  instantly, and the counter-move is visible in the death itself. Fair
  failure motivates; opaque failure is a broken promise.
- **Lose little while learning**: early deaths cost seconds. Punishment can
  scale after investment.
- **Keep something across failure**: best-score deltas, unlock progress —
  a failed run becomes a deposit ("one more run").
- **Celebrate near-misses**: "Best: 412 — you got 398" reframes failure as
  approach.

## Assist mode (Celeste model)

For any skill-gated game, ship granular, judgment-free assists: game speed
50–100%, extra HP/invulnerability, skip-section. Available from the start,
reversible mid-game, named neutrally ("Assist Mode", never "Easy/Cheat
Mode"), no "intended experience" framing, no score asterisks unless
competitive integrity truly demands it (Thorson). Baseline accessibility is
onboarding too: readable text, never color alone as a signal, remappable or
multiple input schemes, pause anywhere.

## Session shape

- **First full loop ≤ 60–90s** — a complete win-or-lose cycle with a score in
  the first minute.
- **Result screen = 1 glance, 1 button**: score, best, delta, play-again.
- **End every session with an open loop**: next unlock, almost-beaten score,
  teased content — adjacent to the retry button.

## Audit checklist (every "no" is a defect)

1. Meaningful input within 5s of load?
2. Core verb performed in real play within 30s?
3. Every instruction ≤ 8 words; first-minute total < ~25 words?
4. Mute all text — still discoverable through doing?
5. Each mechanic introduced alone, failure cheap or impossible?
6. First failure shows what killed you + hints the counter?
7. Death-to-retry one input, < 2s?
8. Session ends with a visible reason to replay (delta, unlock, tease)?
9. Every object's function readable from its appearance?
10. Difficulty has recovery valleys after spikes?
11. Zero modal popups/cutscenes/settings before first play?
12. Native input works immediately (touch on mobile, keys on desktop)?
13. Skill-gated game has a neutral, mid-game-reachable assist option?
14. Something softens after 3–5 failures at the same spot?
15. Score/goal visible at all times?

## Sources

- George Fan, "How I Got My Mom to Play Through Plants vs. Zombies" (GDC 2012) — gdcvault.com/play/1015541/How-I-Got-My-Mom
- Jenova Chen, _Flow in Games_ — jenovachen.com/flowingames/Flow_in_games_final.pdf
- Koster, _A Theory of Fun_ retrospective — gamedeveloper.com/design/raph-koster-s-theory-of-fun-ten-years-on
- Juul, _The Art of Failure_ — mitpress.mit.edu/9780262529952/the-art-of-failure/
- GMTK, "Half-Life 2's Invisible Tutorial" — youtube.com/watch?v=MMggqenxuZc
- Thorson on Celeste's Assist Mode — vice.com/en/article/celeste-difficulty-assist-mode/

Related skills: `design-lenses` (finds the problems this skill fixes),
`level-design` (teaching through geometry), `game-feel` (the juicy first
input), `game-playbook` (build order).
