---
name: game-balance
description: "Game systems, loops, economy and balance math — core-loop construction, sources/sinks, cost & power curves with real formulas, loot tables, pity timers, prestige math, dominant-strategy audits — from Schreiber's Game Balance Concepts, Daniel Cook's skill atoms & loot tables, Machinations, Hopson's reward schedules, and idle-game math. Use when: 'balance my game', 'tune the upgrades', 'design the economy', 'add progression/levels/XP', 'players found one strategy and spam it', 'design loot drops', 'add a prestige system', 'is my difficulty curve right?', or auditing for soft-locks and dominant strategies."
---

# Systems, loops & balance

Games are loops, not arcs: model → action → rules → feedback, nested at every
timescale. Fun is acquiring skills before old ones burn out; balance is mostly
figuring out what numbers to use. What the player can't perceive doesn't exist
— surface the math.

## Core loop construction

- **Write the loop sentence first**: "player does A, system responds B,
  player gets C, which lets them do A better/differently." Can't write it =
  no game yet.
- **Nest 3 timescales**: moment loop (~1s: dodge/shoot), session loop (2–5
  min: a run/wave/level), meta loop (across sessions: upgrades, unlocks,
  best score). Each loop's output feeds the next one up.
- **Close every skill atom**: each verb needs action + rule + feedback
  (<100ms) + perceived reward. A reward with no feedback is invisible.
- **Full loop cycle in the first 10–30s.** Lore and intros come after the
  hook, or never. Cut content that neither repeats nor teaches the loop.
- **Schedule against burnout**: list skill atoms, estimate when each is
  mastered, introduce a new one (mechanic, enemy, modifier) before the old
  one dies — every 30–60s in a 5-minute game.

## Economy: sources & sinks (Machinations vocabulary)

- **Table every resource × (sources, sinks, converters, caps).** Sources with
  no sink → inflation; sinks with no source → soft-lock; a converter strictly
  better than another in all states → dead option.
- **Decisions live at converters** (gold→tower, scrap→upgrade), not at raw
  sources. Want more decisions? Add competing conversions, not more income.
- **Cap or decay hoardables** when hoarding is degenerate (ammo, energy).
- **Faucet-of-last-resort**: every spendable resource needs an income path
  from zero (trickle, sell-back, free reroll) — fix soft-locks structurally,
  not with warnings.

## Cost & power curves

- **Transitive balance rule** (Schreiber): sum(costs) = sum(benefits) on one
  resource scale. Pick a numéraire (gold, DPS-seconds) and price everything
  in it. Conditional/limited benefits get a discount, never a refund — a
  limitation is never worth more than the benefit it limits.
- **Price choice at its best option**: an ability offering a choice costs as
  much as its strongest branch.
- **Derive unknowns pairwise**: find two items differing in exactly one
  attribute, solve for it; bootstrap the curve from 3–4 hand-tuned anchors.
- **Err weak**: a too-weak option is ignored; a too-strong one deletes every
  other option from the game.
- **Upgrade price curve**: `cost(n) = base × growth^n`. Real-world growth
  constants: 1.07 (AdVenture Capitalist, gentle) to ~1.15 (Cookie Clicker,
  steep). Production stays linear in `owned` with milestone multipliers (×2
  at 25/50/100) — exponential cost vs polynomial income guarantees the
  slow-down wall that makes progression feel earned.
- **XP curves**: increasing cost-to-next-level — fast early levels (hook),
  but time-per-level never exceeds one session without a payoff.
- **Perceived difficulty** = (skill + power demanded) − (skill + power held)
  (Schreiber). Player skill rises on its own across sessions — a fixed
  challenge curve drifts easier.
- **Upgrades should change decisions, not just numbers**: ≤3 pure stat bumps
  between mechanic-changing purchases. Want build variety? Make tradeoffs
  intransitive (rock-paper-scissors), which no single cost curve can solve.
- **Show cost, current effect, next effect** on every upgrade.

## Reward scheduling & loot

- **Default to variable-ratio** for drops/crits/bonuses (Hopson): steadiest
  engagement, no post-reward pause. Rewards must feel earned.
- **Weight tables, not percentages** (Cook): integer weights per item
  including a `null` entry; roll against the sum. Compose hierarchically —
  a parent table whose entries are sub-tables lets you cap a sub-pool
  without touching the rest.
- **Sample without replacement to control streaks** (the Tetris bag):
  remove/decrement on drop, refill when empty.
- **Pity timers**: each miss, shrink non-target weights by
  `100 / max_rolls_before_guarantee` percent — certain by roll N, still feels
  random. Add one when the max dry streak exceeds ~2× the expected.
- **Never silently nerf an established reward rate** — extinction produces
  persistence, then frustration, then quitting (Hopson). Replace, don't
  reduce.

## Feedback loops & prestige

- **Mark every loop + or −.** Positive (kills → power → kills) snowballs and
  ends runs — give it a brake (caps, exponential costs, difficulty scaling)
  or make the snowball the point. Negative (rubber-banding) stabilizes —
  dampen the leader, never erase them; catch-up that cancels skill reads
  unfair. Don't use catch-up mechanics to mask a broken cost curve.
- **Prestige = reset for a permanent multiplier.** Production formulas:
  Cookie Clicker `∛(lifetime/10¹²)`, AdVenture Capitalist
  `150·√(lifetime/10¹⁵)`, Egg Inc `(run/10⁶)^0.14`. Lifetime-based pushes
  longer runs each cycle; run-based encourages frequent resets — for
  minutes-long browser games, run-based usually fits. First prestige should
  arrive in the first session or two; place milestone bumps just past the
  natural wall so reset always has a visible goal.

## Balance audit (scriptable — simulate the economy headlessly)

1. **Inventory**: resource table per above; flag inflation/soft-lock/dead
   options.
2. **Soft-lock sweep**: for each spendable, simulate worst-case spending to
   zero — is there an income path back?
3. **Dominant strategy check**: benefit/cost for every option at early/mid/
   late states. Anything >15–20% above the curve will be the only choice;
   anything nobody would buy gets buffed or cut.
4. **Difficulty-vs-power race**: plot challenge (enemy HP/DPS/speed per
   minute) against attainable player power. No unwinnable wall, no long
   boredom plateau, trivial only for the first ~30s.
5. **Reward cadence**: simulate a session; want feedback every few seconds,
   a meaningful choice every 30–90s, a session payoff at the end. Check max
   dry streaks on rares.
6. **Loop polarity review**: every + loop has a brake, every − loop dampens
   rather than erases.
7. **Prestige math** (if any): second run measurably faster; the wall arrives
   at ≈ intended session length.
8. **Watch one real first-timer** (or cold playtest): your numbers were
   calibrated by someone who's played 1,000 times.

Related skills: `design-lenses` (Meaningful Choices/Reward lenses find what
this fixes), `level-design` (wave scaling), `onboarding` (difficulty feel),
`game-playbook` (build order).
