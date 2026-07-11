# Changelog

## 0.1.0 — 2026-07-11

- First npm release
- `VirtualGamepad` core: floating analog stick + fixed/"rest" action buttons, edge-triggered `justPressed`/`justReleased`, pointer reconcile for lost touch-ups
- Phaser adapter (`@vibedgames/gamepad/phaser`): scene-wired input + screen-fixed Graphics overlay, button labels, per-player `setTint`
- DOM adapter (`@vibedgames/gamepad/dom`): pointer-events-none overlay for Three.js/canvas games, interactive-element ignore list
- `PhysicalGamepad`: real controllers (Gamepad API, standard mapping) behind the same read API — bindings, `getStick` → `StickState`, analog `buttonValue`, injectable poll for headless tests; `isPadConnected()` helper
- Safe-area-aware button anchoring (notch / home indicator insets)
