---
name: game-ui
description: "Game interface craft — HUD zoning and hierarchy, fixed-width numerals, alert-color roles, meters over stat cards, menu/overlay states, touch controls (44px targets, safe-area insets, pointer-release handling) — for Phaser, Three.js, and DOM overlays. Use when: building or reviewing a HUD, score/timer/health display, pause/fail/win menus, on-screen touch controls, 'the UI looks like a website', clipped or shifting text, or any in-game interface work."
---

# Game UI

Build a game interface, not a web dashboard. The defining failure of
prompt-built game UI: nested cards, marketing-hero title screens, generic
dashboard styling, and web-app typography wrapped around a canvas.
Anti-patterns to reject on sight: stat cards in rounded boxes inside boxes,
a hero section with a tagline over the game, `<h1>`-styled headings in a HUD,
one-note purple/blue gradient panels.

Hierarchy follows gameplay priority: survival/status first, objective/progress
second, immediate feedback third, flavor last. Prefer meters, icons, cooldown
rings, badges, and compact clusters over labeled stat cards — a meter is read
at glance-speed mid-dodge; a card is not.

## HUD zoning

- **Top-left**: objective, wave, distance, timer, progress.
- **Top-right**: score, currency, combo, pause.
- **Bottom-left/right**: touch movement/action controls (mobile).
- **Center**: reserved for transient banners (wave start, combo, warnings) —
  never persistent chrome, never stacked banners over the play path.
- **In-world (diegetic) where possible**: target markers, off-screen threat
  indicators, damage numbers, prompts anchored to the thing itself.
- Keep all UI out of the play path — away from the player, threats, pickups,
  and the next decision.

## Numbers that don't dance

- **Fixed-width numeric containers** for score, timer, ammo, speed, health:
  tabular numerals (`font-variant-numeric: tabular-nums`) or a monospace face.
  Changing values must never shift layout.
- **Test the longest likely value**: max score, `MM:SS` timer, multi-digit
  combo. No clipping, no wrap, no neighbor displacement.
- Animate value changes briefly (count-up, meter fill, pulse) — a silently
  incrementing corner number reads as broken (see `game-feel`).

## Color roles

One color = one meaning, everywhere: danger (damage, low health), reward
(score, pickups), shield/defense, boost/power, objective, disabled. A limited
status palette over neutral surfaces beats a rainbow. Critical states get two
channels (color + shape/motion/sound) — never color alone.

## Menus & overlays

- Required states beyond the HUD: pause/resume, fail/retry, win/next when
  relevant. Primary action first and biggest (resume, retry); secondary
  actions (settings, quit) smaller.
- Buttons have stable dimensions plus hover/pressed/focus/disabled states.
- Overlays pause underneath, act in one input, and never look like a landing
  page. Debug/tuning UI gates behind a dev flag or query param — it never
  ships as player UI.
- UI reads from the game state (single source of truth) and dispatches
  intents; check for stale values after restart.

## Touch controls (mobile)

- **~44 CSS px minimum touch targets**, with enough separation that adjacent
  controls can't be fat-fingered.
- **Safe-area insets**: pad edge controls with `env(safe-area-inset-*)`;
  nothing interactive under the notch or home indicator.
- **Release paths**: handle `pointerup`, `pointercancel`,
  `lostpointercapture`, window `blur`, and visibility change — a stuck
  virtual button is a stuck key. Controls emit the same game intents as
  keyboard.
- `touch-action: none` only on the game surface and control regions, so page
  scroll/zoom can't steal input.
- Don't scale text with viewport width; use `clamp()` with sane floors.
  Verify portrait and landscape if both are supported.

## Ship checklist

- [ ] First screen is the game (or a deliberate modal), not a landing page.
- [ ] No nested cards / dashboard styling / marketing-hero layout.
- [ ] HUD zones match the map above; center is transient-only.
- [ ] Score/timer/ammo use fixed-width numerals; longest value tested.
- [ ] Alert colors consistent; critical states have ≥2 feedback channels.
- [ ] Pause, fail/retry (one input, <2s), win states exist and work.
- [ ] Text legible over bright, dark, and moving backgrounds.
- [ ] Mobile: 44px targets, safe-area insets, release-path handling, no
      overlap between controls and HUD warnings.
- [ ] No layout shift, clipping, or overlap at desktop / narrow / phone
      widths.
- [ ] Debug UI gated; no stale HUD values after restart.

Related skills: `game-feel` (juice on value changes), `onboarding` (first-30s
and control hints), `design-lenses` (Feedback/Accessibility lenses),
`gamepad` (physical controller labels/glyphs).
