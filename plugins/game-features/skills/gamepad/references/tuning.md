# Tuning, visibility and the raw core

## Tuning

```ts
attachVirtualGamepad(this, {
  stick: {
    radius: 64, // drag distance (px) that maps to full magnitude
    deadZone: 8, // no thrust / no re-aim within this drag (parked thumb)
    knobRadius: 26, // visual puck size
  },
  // stick: false,   // disable the stick entirely (buttons-only)
  // extraPointers defaults to buttons + 2, so simultaneous holds aren't dropped
  visible: "coarse", // pre-show fixed buttons on touch devices (default "touch")
  render: {
    depth: 95, // above the world, below a DOM HUD
    tint: 0xffffff, // knob + button color
    blendMode: Phaser.BlendModes.ADD, // ADD glows on dark scenes; NORMAL for bright
  },
});

// Recolor at runtime (e.g. to the local player's color), e.g. each frame:
this.gamepad.setTint(this.myPlayerColor());
```

Pass `render: false` to suppress the built-in renderer and draw it yourself
from `gamepad.pad` (`getStickGeometry()`, `getStick()`, `getButtonLayout()`).

`setVisible(false)` (either adapter) hides the overlay regardless of the
`visible` policy — behind a start screen, say — and input keeps working while
hidden.

## Visibility

By default the overlay renders only after the first touch. Fixed buttons that
don't exist until you touch the screen are undiscoverable — pass
`visible: "coarse"` (either adapter) to pre-show them on touch-capable
devices. Desktop with a mouse still never sees them.

## Framework-agnostic core (custom routing / custom renderer)

Reach for the raw core only when the DOM adapter doesn't fit (custom event
sources, in-engine rendering). Coordinates are **CSS pixels** — use
`clientX/clientY`, never `offsetX` against `canvas.width` (a HiDPI canvas
buffer is larger than its on-screen size, which mis-anchors fixed buttons).

```ts
import { VirtualGamepad, safeAreaInset, stickDirection8 } from "@vibedgames/gamepad";

const pad = new VirtualGamepad({ buttons: [{ id: "jump" }] });
pad.setViewport(window.innerWidth, window.innerHeight, safeAreaInset()); // re-call on resize

window.addEventListener("pointerdown", (e) => pad.pointerDown(e.pointerId, e.clientX, e.clientY));
window.addEventListener("pointermove", (e) => pad.pointerMove(e.pointerId, e.clientX, e.clientY));
window.addEventListener("pointerup", (e) => pad.pointerUp(e.pointerId));
window.addEventListener("pointercancel", (e) => pad.pointerUp(e.pointerId));

// each frame:
pad.reconcile([...activePointerIds]); // drop touches whose up was missed
pad.nextFrame(); // publish justPressed/justReleased edges
const stick = pad.getStick();
const dir = stickDirection8(stick); // 8-way, or stickDirection4 for grids
const jumping = pad.isButtonDown("jump");
// …then render the overlay yourself from pad.getStick()/getButtonLayout().
```

## Drawing your own screen-fixed objects through a zoomed camera

`setScrollFactor(0)` cancels the camera's scroll and nothing else — a zoomed
or rolled camera still transforms the object. The Phaser adapter counters that
itself every frame (`@vibedgames/gamepad` ≥ 0.1.2, drawn at `PRE_RENDER` so a
camera moved later in the frame can't leave it a frame behind). For your own
HUD objects, `screenSpaceTransform(cameraView(scene.cameras.main))` gives the
position/rotation/scale under which local coordinates are canvas pixels, and
`screenSpacePosition(transform, x, y)` places a sibling object at canvas point
(`x`, `y`).
