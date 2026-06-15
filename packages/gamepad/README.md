# @vibedgames/gamepad

On-screen touch controls for browser games — a floating analog joystick plus
action buttons. Framework-agnostic core, with a drop-in [Phaser](https://phaser.io)
adapter that wires the input and renders the overlay for you.

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

### Fixed buttons (e.g. a bomb button)

Give a button a `position` resolver to pin it on-screen; it re-anchors on
resize. Use `onButtonDown` for edge-triggered actions (place a bomb once per
tap) and `isButtonDown` for held input.

```ts
attachVirtualGamepad(this, {
  buttons: [
    {
      id: "bomb",
      position: ({ width, height }) => ({ x: width - 80, y: height - 80 }),
      radius: 48,
    },
  ],
  onButtonDown: (id) => {
    if (id === "bomb") this.placeBomb();
  },
});
```

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
events in screen-space pixels and read the state back. Use it with Three.js,
canvas, or plain DOM.

```ts
import { VirtualGamepad } from "@vibedgames/gamepad";

const pad = new VirtualGamepad({ buttons: [{ id: "jump" }] });
pad.setViewport(canvas.width, canvas.height);

canvas.addEventListener("pointerdown", (e) => pad.pointerDown(e.pointerId, e.offsetX, e.offsetY));
canvas.addEventListener("pointermove", (e) => pad.pointerMove(e.pointerId, e.offsetX, e.offsetY));
canvas.addEventListener("pointerup", (e) => pad.pointerUp(e.pointerId));

// each frame:
const stick = pad.getStick();
const jumping = pad.isButtonDown("jump");
```

### Touch routing

Each `pointerDown` is routed in order:

1. **Fixed buttons** — a touch inside a button's circle presses it.
2. **The stick** — the first free touch anchors the floating stick.
3. **A "rest" button** (a button with no `position`) — catches everything else.

This covers both the twin-stick model (stick + a rest "fire" button: any
second finger shoots) and the d-pad-style model (stick + a fixed action
button).

## License

MIT
