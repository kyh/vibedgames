# Changelog

## Unreleased

- `keyTapper()` — press/release cycling for keydown-edge verbs inside a reflex
- `pointerAim(dx, dy)` — 2D cursor-as-heading reflex helper
- `TestHooks.setState` may return a Promise; `TestHooks.seed` is optional (the playtest falls back to a `?seed=` reload)
- `Diagnostics.player` accepts `null` and any subset of x/y/z

## 0.1.0 — 2026-09-19

- First npm release
- Types for the playtest contract: `Diagnostics`, `TestHooks`, `PlaytestManifest` (`MoveOption`, `ActionOption`, `Reflex`, `ReflexInputs`, `PlaytestPointer`)
- `publishDiagnostics(read)` — `window.__GAME_DIAGNOSTICS__` as a live getter
- `publishTestHooks(hooks)`, `publishPlaytest(manifest)` — the other two globals, the manifest checked the way `vg playtest run` checks it
- `definePlaytest(manifest)` for typing a manifest built elsewhere; `isPlaytestRequested()` for the `?test=1` gate
- `PlaytestManifest.minDisplacement` — the input-alive gate in the game's own units, for games that measure in world units rather than pixels
- `pointerTracker(options)` — the per-frame cursor-walking reflex for games that steer from the pointer
