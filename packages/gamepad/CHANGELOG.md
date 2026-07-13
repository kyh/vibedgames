# Changelog

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
