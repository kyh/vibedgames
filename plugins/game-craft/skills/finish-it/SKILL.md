---
name: finish-it
description: "Scope-cutting and shipping discipline from Derek Yu's 'Finishing a Game' and 'Death Loops', jam culture, and veteran shipping practice — diagnose why a game project stalled, cut to a shippable core, define a binary finish line, ship it. Use when: a game project is stalled or sprawling, 'I keep adding features', 'it's never done', 'should I add X before shipping?' (usually no), 'help me finish this', 'is this ready to ship?', or scoping a new game so it actually ships."
---

# Finish it

Finishing is a separate skill, and a finished mediocre game proves more than a
brilliant fragment. Projects die in two loops: the **restart loop** (skills
improved mid-project, so the dev remakes early content sideways forever — "your
code will always be a mess") and the **polish loop** (near-done, endlessly
refining details out of fear of judgment). Diagnose the loop before
intervening. And remember: **the last 10% is really 90%** — menus, death
states, audio plumbing, deploy are the game too.

## Scoping a new game (so this skill is never needed)

- **One core mechanic, one level/arena, one win condition, one lose
  condition.** Everything else is stretch.
- **One-sentence pitch before code.** Features not in the sentence need
  explicit justification.
- **Budget 50/50**: half for the playable loop, half for the unfun tail. If
  the loop fills the budget, the scope is wrong.
- **Prototype-first split** (jam culture): playable ugly loop in the first
  ~5% of the time; the rest is feel, art, sound, content.
- **Use the engine at hand** (Spelunky shipped in Game Maker), reuse and
  generate assets without shame.
- **Tiny finished games grow up**: Celeste began as a 4-day PICO-8 jam game.
  The jam-sized version is the validation step, not a compromise.

## The cut list

- Keep a `NEXT_GAME.md`. Every mid-build idea ("what if it had shops /
  multiplayer / procgen") goes there, not in the build. Save it for the next
  one — finish this one first (Yu).
- **Default cut order** for browser games: extra levels → extra enemy/item
  types → meta-progression → settings menus → narrative → leaderboards.
- **Never cut**: restart flow, lose/win states, audio toggle.
- When behind: cut features. One mechanic deep beats three shallow.
- If a project must die, the successor is _smaller_, not bigger.

## When is the core loop enough?

Stop adding mechanics when: a new player understands it without instructions
in <30s, a session has tension (can lose) and release (can win/score), and a
player voluntarily restarts once. From that moment, every proposal to add is
scope creep — route it to `NEXT_GAME.md` and switch to finishing mode.

## The intervention (stalled project)

1. **Diagnose the loop.** Check git history / file churn: redoing existing
   things = restart loop; refining done things = polish loop; new systems
   with no win state = creep. Name it plainly: "Last 5 sessions added 3
   systems and the game still has no win state."
2. **Extract the one-sentence core** — single mechanic + win + lose. If
   unclear, the smallest already-fun interaction in the build IS the game.
3. **Triage every feature** (built, half-built, planned): KEEP (serves the
   core loop), CUT (delete now), DEFER (→ `NEXT_GAME.md`). Half-built
   defaults to CUT — "just finishing it" is the restart loop's bait.
4. **Write the finish line** as the checklist below, agreed explicitly:
   boxes may be removed, never added.
5. **End-to-end first**: title → play → lose → restart → win reachable with
   placeholders before any item-level polish.
6. **One juice pass, one tuning pass, timeboxed.** The second polish pass is
   the polish death-loop.
7. **Ship** (`vg deploy`), cold-load the live URL, play one full session on
   the deployed build, fix only blockers.
8. **Debrief**: share the link, log deferred ideas, at most one v1.1 scoped
   to ≤5 checklist items. Ship-then-iterate beats a delayed "complete" v1 —
   deploys are cheap here.
9. **If the user resists** ("one more feature"): offer to swap it for an
   existing checklist item. Never silently extend.

## Shipping checklist (binary; all boxes or no ship)

- [ ] Title screen: name + how to start + minimal controls hint
- [ ] Core loop playable start-to-finish with no dev knowledge
- [ ] Lose state reachable, clear, instant one-input restart
- [ ] Win/goal state reachable (or endless loop with score + best visible)
- [ ] Restart fully resets state — replay 3+ times (no stale timers/listeners)
- [ ] No placeholder art/text ("TODO", magenta boxes, template logo)
- [ ] Page title + favicon + meta description set
- [ ] Mobile viewport meta; page doesn't scroll/zoom under game input; canvas
      scales to the window
- [ ] Touch controls, or an explicit "keyboard required" notice on mobile
- [ ] SFX exist, start only after user gesture, mute toggle works
- [ ] Tab-blur handled: no desync/physics spiral when backgrounded
- [ ] No console errors across a full session
- [ ] Frame rate holds; no unbounded entity leaks over a long session
- [ ] First-timer survives >15s; a deliberate player can lose
- [ ] All assets load on the deployed path (no localhost/absolute refs)
- [ ] Deployed URL cold-loads in incognito; one full session played LIVE
- [ ] (Multiplayer) host-leave/rejoin tested; solo player not soft-locked

Related skills: `game-playbook` (the build order that avoids stalling),
`deploy` (the finish line), `design-lenses` (is the core loop enough),
`ask-me` (scope the next game properly before starting).
