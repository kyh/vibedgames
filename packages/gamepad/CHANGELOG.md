# Changelog

## 0.1.2 — 2026-08-15

- Fixed: the Phaser overlay drew where it was **not** hit-tested on any scene whose
  camera zoom is not 1. Buttons are positioned and hit-tested in canvas pixels, but
  the overlay was drawn with only `setScrollFactor(0)` — which cancels the camera's
  *scroll* and nothing else, so it still rode the zoom. A fixed button could render
  far enough from its touch target to be a decoy: at zoom 0.82 one sat 65px from a
  52px hit circle, i.e. completely unhittable at the place it appeared. The overlay
  now counters the camera's zoom **and roll** every frame, and is drawn at
  `PRE_RENDER` rather than from `update()` so a camera moved later in the frame
  cannot leave it a frame behind. Games on a zoom-1 camera are unaffected.
- Added: `screenSpaceTransform()` / `screenSpacePosition()` (and the `CameraView` /
  `ScreenSpaceTransform` types) for games that draw their own screen-fixed objects
  through a zoomed camera.
- The Phaser peer range is now `>=3.53` — `Scenes.Events.PRE_RENDER` is required.

## 0.1.1 — 2026-07-13

- The package now imports under plain Node ESM. Relative imports carry explicit `.js`
  extensions, so the emitted `dist` re-exports `./core.js` rather than `./core` —
  extensionless specifiers are what `moduleResolution: "bundler"` emits, and Node ESM
  rejects them, so 0.1.0 failed with `ERR_MODULE_NOT_FOUND` on import. It went unnoticed
  because bundlers resolve extensionless imports happily and every consumer so far went
  through one. No API or behaviour change.

## 0.1.0 — 2026-07-11

- First npm release
- `VirtualGamepad` core: floating analog stick + fixed/"rest" action buttons, edge-triggered `justPressed`/`justReleased`, pointer reconcile for lost touch-ups
- Phaser adapter (`@vibedgames/gamepad/phaser`): scene-wired input + screen-fixed Graphics overlay, button labels, per-player `setTint`
- DOM adapter (`@vibedgames/gamepad/dom`): pointer-events-none overlay for Three.js/canvas games, interactive-element ignore list
- `PhysicalGamepad`: real controllers (Gamepad API, standard mapping) behind the same read API — bindings, `getStick` → `StickState`, analog `buttonValue`, injectable poll for headless tests; `isPadConnected()` helper
- Safe-area-aware button anchoring (notch / home indicator insets)
