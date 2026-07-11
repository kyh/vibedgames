# @vibedgames/gamepad

On-screen touch controls for browser games — a floating analog joystick plus
action buttons. Framework-agnostic core, with drop-in adapters that wire the
input and render the overlay for you: a [Phaser](https://phaser.io) adapter
(`@vibedgames/gamepad/phaser`) and a DOM adapter (`@vibedgames/gamepad/dom`)
for everything else — Three.js, raw canvas, plain pages.

## Install

```sh
npm install @vibedgames/gamepad
```

## Phaser quickstart

```ts
import { attachVirtualGamepad } from "@vibedgames/gamepad/phaser";

// in your scene's create():
this.gamepad = attachVirtualGamepad(this, {
  // a "rest" button (no position) — any finger that isn't the stick fires:
  buttons: [{ id: "fire" }],
  onFirstTouch: () => this.hint?.remove(),
});

// in your scene's update():
this.gamepad.update(); // reconcile stale touches + redraw the overlay

const stick = this.gamepad.getStick();
if (stick.active && !stick.inDeadZone) {
  this.steer(stick.angle, stick.magnitude); // radians, 0–1 thrust
}
if (this.gamepad.isButtonDown("fire")) this.shoot();
```

The mouse is ignored on purpose, so a desktop build keeps whatever controls it
already had — the gamepad is purely the touch overlay. `isTouch` flips true the
first time a finger lands.

## DOM quickstart (Three.js, canvas, anything)

Same controller, rendered as positioned DOM elements in a
`pointer-events: none` overlay — it never steals taps from your HUD. Touches
on interactive elements (`button`, `a`, inputs, `[data-gamepad-ignore]`) are
left to the page.

```ts
import { attachDomGamepad } from "@vibedgames/gamepad/dom";

const gamepad = attachDomGamepad({
  visible: "coarse", // pre-show buttons on touch devices (default: after first touch)
  buttons: [
    {
      id: "jump",
      label: "JUMP",
      position: (v) => ({ x: v.width - 72 - v.inset.right, y: v.height - 72 - v.inset.bottom }),
    },
  ],
});

// in your game loop:
gamepad.update();
const stick = gamepad.getStick();
if (gamepad.justPressed("jump")) jump();
```

Give your game surface `touch-action: none` so the browser delivers moves
instead of scrolling. `setTint` takes a CSS color here (`"#22d3ee"`).

### Fixed buttons (e.g. a bomb button)

Give a button a `position` resolver to pin it on-screen; it re-anchors on
resize. The resolver's viewport includes safe-area insets (`inset.top/right/
bottom/left` — notch and home indicator, zeros elsewhere; requires
`viewport-fit=cover` in your viewport meta tag on iOS). Use `onButtonDown` or
`justPressed(id)` for edge-triggered actions (place a bomb once per tap) and
`isButtonDown` for held input.

```ts
attachVirtualGamepad(this, {
  buttons: [
    {
      id: "bomb",
      label: "💣",
      position: ({ width, height, inset }) => ({
        x: width - 80 - inset.right,
        y: height - 80 - inset.bottom,
      }),
      radius: 48,
    },
  ],
  onButtonDown: (id) => {
    if (id === "bomb") this.placeBomb();
  },
});
```

Buttons with a `label` render it (text in the DOM adapter, a `Text` object in
Phaser). Pass `visible: "coarse"` to either adapter to pre-show fixed buttons
on touch-capable devices instead of waiting for the first touch — an invisible
button is undiscoverable.

### Grid movement

For tile-based games, snap the stick to a direction:

```ts
import { stickDirection4 } from "@vibedgames/gamepad/phaser";

const dir = stickDirection4(this.gamepad.getStick()); // "up" | "down" | "left" | "right" | null
if (dir) this.step(dir);
```

### Rendering

The Phaser adapter draws the joystick + fixed buttons into a screen-fixed
`Graphics` object. Tune it with `render: { depth, tint, blendMode }`, recolor at
runtime with `setTint(0xff00aa)`, or pass `render: false` and draw it yourself
from `gamepad.pad` (see `getStickGeometry`, `getStick`, `getButtonLayout`).

## Framework-agnostic core

The `VirtualGamepad` class has no engine dependency — feed it raw pointer
events in screen-space (CSS pixel) coordinates and read the state back. Most
non-Phaser games want `attachDomGamepad` instead; drive the core directly only
for custom event routing or a custom renderer.

```ts
import { VirtualGamepad, safeAreaInset } from "@vibedgames/gamepad";

const pad = new VirtualGamepad({ buttons: [{ id: "jump" }] });
pad.setViewport(window.innerWidth, window.innerHeight, safeAreaInset());

// clientX/clientY, NOT offsetX or canvas.width — the pad works in CSS pixels,
// and a HiDPI canvas's buffer size is larger than its on-screen size.
window.addEventListener("pointerdown", (e) => pad.pointerDown(e.pointerId, e.clientX, e.clientY));
window.addEventListener("pointermove", (e) => pad.pointerMove(e.pointerId, e.clientX, e.clientY));
window.addEventListener("pointerup", (e) => pad.pointerUp(e.pointerId));
window.addEventListener("pointercancel", (e) => pad.pointerUp(e.pointerId));

// each frame:
pad.nextFrame(); // publish justPressed/justReleased edges
const stick = pad.getStick();
const jumping = pad.isButtonDown("jump");
```

Touch `up` events can go missing (finger slides off the canvas, tab switch) —
call `pad.reconcile(liveIds)` each frame with the pointer ids you know are
down, or `pad.reset()` on blur, like the adapters do.

### Touch routing

Each `pointerDown` is routed in order:

1. **Fixed buttons** — a touch inside a button's circle presses it.
2. **The stick** — the first free touch anchors the floating stick.
3. **A "rest" button** (a button with no `position`) — catches everything else.

This covers both the twin-stick model (stick + a rest "fire" button: any
second finger shoots) and the d-pad-style model (stick + a fixed action
button).

## Physical controllers

`PhysicalGamepad` reads real controllers (the
[Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API),
standard mapping, first connected pad wins) with the same read API as the
virtual pad, so one code path serves both. Bind your game's action ids to
physical buttons and poll once per frame:

```ts
import { PhysicalGamepad, stickDirection4 } from "@vibedgames/gamepad";

const pad = new PhysicalGamepad({
  bindings: { jump: ["a"], dash: ["b", "rb"] },
  onConnect: () => showToast("🎮 controller connected"),
});

// in your game loop:
pad.update();
const dir = stickDirection4(pad.getStick()); // left stick; getStick("right") too
const jumped = vpad.justPressed("jump") || pad.justPressed("jump");
```

Raw button names (`"a"`, `"rt"`, `"up"`, …) work without a binding, and
`buttonValue("rt")` exposes analog trigger values for driving games.
`isPadConnected()` is a standalone check for UI ("show controller hints only
when a pad is plugged in"). Everything is poll-based — no listeners, no DOM —
and the pad source is injectable (`poll`) for headless tests.

## Related

- [`@vibedgames/multiplayer`](https://www.npmjs.com/package/@vibedgames/multiplayer) — real-time multiplayer for browser games (framework-agnostic core + React hooks). Pairs naturally: recolor the joystick/buttons per player with `setTint`.

## License

MIT
