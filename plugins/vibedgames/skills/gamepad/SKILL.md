---
name: gamepad
description: "Add touch controls (virtual joystick, d-pad, buttons) and physical gamepad support to a browser game with @vibedgames/gamepad."
---

# Vibedgames Gamepad

Add on-screen touch controls — a floating analog joystick plus action buttons — and physical controller input to any browser game with `@vibedgames/gamepad`. Framework-agnostic core, with drop-in adapters that wire the input and render the overlay for you: one for Phaser, one for the DOM (Three.js, canvas, anything else).

## Install

```sh
npm install @vibedgames/gamepad
```

`phaser` is an **optional** peer dependency — only needed if you use the `/phaser` adapter. The core and `/dom` adapter have no engine dependency.

## Three entry points

- `@vibedgames/gamepad/phaser` — `attachVirtualGamepad(scene, options)` for Phaser games
- `@vibedgames/gamepad/dom` — `attachDomGamepad(options)` for **everything else** (Three.js, canvas, vanilla). Prefer this over the raw core.
- `@vibedgames/gamepad` — framework-agnostic `VirtualGamepad` class (custom event routing / custom renderers only) and `PhysicalGamepad`

## Core concepts

- **Floating stick** — the first free touch anchors a virtual analog stick wherever the finger lands; dragging from the anchor steers. Reads back as `angle` + `magnitude` (0–1 thrust after a dead zone).
- **Action buttons** — either **fixed** (a circle pinned on-screen, e.g. a bottom-right bomb/jump button) or **"rest"** (no position — catches _any_ touch that isn't the stick or a fixed button; this is the "any second finger fires" model).
- **Touch is the overlay.** The adapter ignores the mouse, so a desktop game keeps whatever controls it already had. `isTouch` flips true the first time a finger lands — use it to switch control schemes or swap an on-screen hint.
- **`update()` once per frame is mandatory** (either adapter). It reconciles touches whose `up` was lost (finger slid off-canvas) and publishes `justPressed`/`justReleased` edges. Skip it and the joystick sticks on.
- **Held vs edge:** movement and continuous fire read `isButtonDown(id)` / `getStick()` each frame; one-shot actions (bomb, jump) use `onButtonDown(id)` or `justPressed(id)` after `update()`.

### Touch routing

Each touch-down is routed in order: **fixed buttons → the stick → a "rest" button**. This one model covers both common layouts — a stick + rest "fire" button (twin-stick: move one thumb, any other finger fires), and a stick + fixed action button (grid/platformer: move with the stick, tap to bomb/jump). Both recipes are in [references/recipes.md](references/recipes.md).

## Safe areas (notch / home indicator)

Position resolvers receive `viewport.inset` — the device safe-area insets. Subtract them for bottom/side-anchored buttons (`x: width - 72 - inset.right, y: height - 72 - inset.bottom`) so controls clear the iOS home indicator. Non-zero values require `viewport-fit=cover` in the page's viewport meta tag:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover"
/>
```

The game surface also needs `touch-action: none`, else the browser scrolls instead of delivering moves. An overlay dismissed by tap must cancel its `touchend` (non-passive) or the compatibility `click` lands in the canvas ~1 ms later — `preventDefault()` on `pointerup` does not stop it; see [references/recipes.md](references/recipes.md) → DOM adapter.

## Keep desktop controls; touch is additive

The gamepad never touches the mouse path, so wire it _alongside_ your existing keyboard/mouse code and read whichever is active:

```ts
private readDir(): Dir | null {
  if (this.keys.left.isDown) return "left";
  // … other keys …
  return stickDirection4(this.gamepad.getStick()); // falls through to touch
}
```

For aim-style games, branch on `isTouch`:

```ts
if (this.gamepad.isTouch) {
  const s = this.gamepad.getStick();
  if (s.active) this.aim(s.angle, s.magnitude);
} else {
  this.aimAtCursor(this.input.activePointer);
}
```

## Physical controllers

`PhysicalGamepad` reads real controllers through the Gamepad API (standard mapping, first connected pad wins) behind the **same read API** as the virtual pad — `isButtonDown` / `justPressed` / `justReleased` / `getStick()` — so one input path serves touch and pad. Poll-based: no listeners, no DOM, `update()` once per frame publishes edges.

```ts
import { PhysicalGamepad, isPadConnected, stickDirection4 } from "@vibedgames/gamepad";

const pad = new PhysicalGamepad({
  bindings: { jump: ["a"], dash: ["b", "rb"] }, // game action id → physical buttons
  onConnect: () => showToast("controller connected"),
});

// in your game loop — BEFORE any "connected?" / "started?" gate:
pad.update();
const dir = stickDirection4(pad.getStick()); // left stick; getStick("right") too
if (touch.justPressed("jump") || pad.justPressed("jump")) jump();
const throttle = pad.buttonValue("rt"); // analog 0–1 for driving games
```

- Raw names (`"a"`, `"rt"`, `"start"`, `"up"`, …) work without a binding. Defaults: `stickDeadZone` 0.15, `triggerThreshold` 0.05 (a light trigger pull counts as down).
- **Poll outside net gates.** A game that only calls `pad.update()` once the room is connected can't be started from a pad while connecting — pad-start must work on the start screen.
- **Prime `pad.update()` in scene `create()`.** The trap: a button still held from the previous scene reads as a fresh `justPressed` on the new scene's first frame (a phantom sword swing on entering the mine).
- **Re-render control hints on `gamepadconnected`.** `isPadConnected()` is the cheap standalone check; controller rows belong on an instructions screen only while a pad is plugged in.
- Injectable `poll` (`() => navigator.getGamepads()`-shaped) for headless tests.

**Verify without a controller.** In a Playwright test, `addInitScript` overrides `navigator.getGamepads` with a stub that exposes `window.__pad.connect()` and `window.__pad.set({ axes, buttons })`; the test then sets a stick deflection or a button, ticks a frame, and asserts the game moved / started. Same stub drives a headless smoke of "pad-start while connecting" and "no phantom edge across scenes". Unit tests skip the browser entirely via the `poll` option.

## Local dev loop

1. Desktop first: keyboard/mouse must still work with the pad attached — the adapter never sees the mouse.
2. Touch: DevTools device mode, or a Playwright context with `hasTouch: true` and `page.touchscreen.tap()`. Check the stick anchors under the finger, a fixed button sits clear of the home indicator, and a held touch doesn't stick after sliding off-canvas.
3. Pad: the `getGamepads` stub above, then a real controller on the deployed URL (browser pads only report after a button press).
4. Phone on the LAN: the only check for `viewport-fit=cover` insets and Safari's compatibility-click leak.

## Pointers

- [references/recipes.md](references/recipes.md) — Phaser quickstart (twin-stick), grid recipe (4-way + bomb button), DOM adapter for Three.js/canvas, overlay `touchend` cancellation. Open when wiring the pad into a game.
- [references/tuning.md](references/tuning.md) — stick/render tuning numbers, `visible` policy, `setVisible`, the raw `VirtualGamepad` core, screen-space helpers for zoomed cameras. Open when the defaults look or feel wrong, or you need a custom renderer.

## Anti-patterns

- ❌ **Forgetting `gamepad.update()` (or `pad.reconcile()`).** Lost `up` events leave the stick/button stuck on. Call it every frame.
- ❌ **Reading a held button for a one-shot action.** `isButtonDown("bomb")` is true for the whole press — you'll drop a bomb every frame. Use `onButtonDown` or `justPressed` for tap actions.
- ❌ **Forcing a joystick onto a game with a better native gesture.** Tap-anywhere (flappy), swipe (pacman-style turns), or absolute drag (pong paddles) beat a virtual stick. The package is for games that need held directional movement + action buttons; keep superior gestures as they are.
- ❌ **Driving steering off `angle` while in the dead zone.** A parked thumb has a noisy angle. Gate on `stick.active && !stick.inDeadZone` (or just use `stickDirection4/8`, which already return `null` in the dead zone).
- ❌ **Re-implementing the mouse path inside the adapter.** The adapter is touch-only by design. Keep desktop controls in your own code and read the gamepad as the touch source.
- ❌ **Forgetting to `destroy()` on scene shutdown.** Leaves pointer listeners and the overlay Graphics dangling. Tie it to `SHUTDOWN`.
- ❌ **Dismissing an overlay on `click`, or without cancelling `touchend`.** The compatibility click leaks into the canvas as a phantom tap. Don't dismiss on `click`; use `pointerup` and cancel `touchend`.
- ❌ **Assuming the Phaser overlay rides the camera zoom.** `@vibedgames/gamepad` < 0.1.2 drew the pad zoom-transformed (`setScrollFactor(0)` cancels scroll, not zoom — at zoom 0.82 a button sat 65px from its hit circle). 0.1.2+ counters zoom and roll at `PRE_RENDER`, so the pad works on any scene; a parallel un-zoomed HUD scene is still the cleaner home for overlays (Phaser routes input top-down, so it still receives touches).

## Deploy

`vg deploy ./dist --slug my-game` → live at `https://my-game.vibedgames.com`. See the `deploy` skill for the full flow (use `npx vibedgames deploy` if `vg` isn't on PATH).

## See also

- `multiplayer` (`@vibedgames/multiplayer`) — real-time sync, shared/player state, and host-authoritative logic. Pairs naturally: tint the stick/buttons to each player's color via `setTint`.
