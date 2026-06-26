---
name: gamepad
description: "Add on-screen touch controls (virtual joystick + buttons) to browser games using @vibedgames/gamepad. Use when the user wants mobile/touch controls, a virtual joystick or d-pad, on-screen action buttons, or to make a desktop game playable on phones. Triggers on: 'add touch controls', 'mobile controls', 'make it work on mobile', 'virtual joystick', 'on-screen buttons', 'd-pad', 'thumbstick', 'gamepad'."
---

# Vibedgames Gamepad

Add on-screen touch controls — a floating analog joystick plus action
buttons — to any browser game with `@vibedgames/gamepad`. Framework-agnostic
core, with a drop-in Phaser adapter that wires the input and renders the
overlay for you.

## Install

```sh
npm install @vibedgames/gamepad
```

`phaser` is an **optional** peer dependency — only needed if you use the
`/phaser` adapter. The core has no engine dependency.

## Two entry points

- `@vibedgames/gamepad` — framework-agnostic `VirtualGamepad` class (Three.js, canvas, vanilla DOM)
- `@vibedgames/gamepad/phaser` — `attachVirtualGamepad(scene, options)` that wires pointer events and renders the overlay

## Core concepts

- **Floating stick** — the first free touch anchors a virtual analog stick wherever the finger lands; dragging from the anchor steers. Reads back as `angle` + `magnitude` (0–1 thrust after a dead zone).
- **Action buttons** — either **fixed** (a circle pinned on-screen, e.g. a bottom-right bomb/jump button) or **"rest"** (no position — catches _any_ touch that isn't the stick or a fixed button; this is the "any second finger fires" model).
- **Touch is the overlay.** The adapter ignores the mouse, so a desktop game keeps whatever controls it already had. `isTouch` flips true the first time a finger lands — use it to switch control schemes or swap an on-screen hint.

### Touch routing

Each touch-down is routed in order: **fixed buttons → the stick → a "rest" button**. This one model covers both common layouts — a stick + rest "fire" button (twin-stick: move one thumb, any other finger fires), and a stick + fixed action button (grid/platformer: move with the stick, tap to bomb/jump). Both are shown below.

## Phaser quickstart (twin-stick shooter)

```ts
import { attachVirtualGamepad } from "@vibedgames/gamepad/phaser";

class GameScene extends Phaser.Scene {
  private gamepad!: ReturnType<typeof attachVirtualGamepad>;

  create() {
    this.gamepad = attachVirtualGamepad(this, {
      buttons: [{ id: "fire" }], // rest button: any non-stick finger fires
      onFirstTouch: () => this.hint?.destroy(),
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.gamepad.destroy());
  }

  update() {
    this.gamepad.update(); // ALWAYS call once per frame: reconciles + redraws

    const stick = this.gamepad.getStick();
    if (stick.active && !stick.inDeadZone) {
      this.steer(stick.angle, stick.magnitude); // radians, 0–1
    }
    if (this.gamepad.isButtonDown("fire")) this.shoot();
  }
}
```

> **`update()` every frame is mandatory.** It reconciles touches whose `up`
> event was lost (finger slid off-canvas) and redraws the overlay. Skip it and
> the joystick "sticks" on.

## Phaser recipe: grid game (joystick → 4-way + a bomb button)

```ts
import { attachVirtualGamepad, stickDirection4 } from "@vibedgames/gamepad/phaser";

this.gamepad = attachVirtualGamepad(this, {
  buttons: [
    {
      id: "bomb",
      // re-anchors on resize; viewport is the live canvas size
      position: ({ width, height }) => ({ x: width - 84, y: height - 84 }),
      radius: 52,
    },
  ],
  render: { depth: 1000, blendMode: Phaser.BlendModes.NORMAL }, // NORMAL for bright scenes
  onButtonDown: (id) => {
    if (id === "bomb") this.placeBomb(); // edge-triggered: fires once per tap
  },
});

// in update(), after this.gamepad.update():
const dir = stickDirection4(this.gamepad.getStick()); // "up"|"down"|"left"|"right"|null
if (dir) this.step(dir);
```

**Held vs. edge input:**

- Held (movement, continuous fire): read `isButtonDown(id)` / `getStick()` each frame.
- Edge (place a bomb, jump once per tap): use the `onButtonDown(id)` / `onButtonUp(id)` callbacks.

## Keep desktop controls; touch is additive

The gamepad never touches the mouse path, so wire it _alongside_ your existing
keyboard/mouse code and read whichever is active:

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

## Tuning

```ts
attachVirtualGamepad(this, {
  stick: {
    radius: 64, // drag distance (px) that maps to full magnitude
    deadZone: 8, // no thrust / no re-aim within this drag (parked thumb)
    knobRadius: 26, // visual puck size
  },
  // stick: false,   // disable the stick entirely (buttons-only)
  extraPointers: 2, // simultaneous touches beyond the default (default 2 → 3 total)
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

## Framework-agnostic core (Three.js / canvas / vanilla)

```ts
import { VirtualGamepad, stickDirection8 } from "@vibedgames/gamepad";

const pad = new VirtualGamepad({ buttons: [{ id: "jump" }] });
pad.setViewport(canvas.width, canvas.height); // re-call on resize

canvas.addEventListener("pointerdown", (e) => pad.pointerDown(e.pointerId, e.offsetX, e.offsetY));
canvas.addEventListener("pointermove", (e) => pad.pointerMove(e.pointerId, e.offsetX, e.offsetY));
canvas.addEventListener("pointerup", (e) => pad.pointerUp(e.pointerId));
canvas.addEventListener("pointercancel", (e) => pad.pointerUp(e.pointerId));

// each frame:
pad.reconcile([...activePointerIds]); // drop touches whose up was missed
const stick = pad.getStick();
const dir = stickDirection8(stick); // 8-way, or stickDirection4 for grids
const jumping = pad.isButtonDown("jump");
// …then render the overlay yourself from pad.getStick()/getButtonLayout().
```

## Anti-patterns

❌ **Forgetting `gamepad.update()` (or `pad.reconcile()`).**
Lost `up` events leave the stick/button stuck on. Call it every frame.

❌ **Reading a held button for a one-shot action.**
`isButtonDown("bomb")` is true for the whole press — you'll drop a bomb every
frame. Use `onButtonDown` for tap actions.

❌ **Driving steering off `angle` while in the dead zone.**
A parked thumb has a noisy angle. Gate on `stick.active && !stick.inDeadZone`
(or just use `stickDirection4/8`, which already return `null` in the dead zone).

❌ **Re-implementing the mouse path inside the adapter.**
The adapter is touch-only by design. Keep desktop controls in your own code and
read the gamepad as the touch source.

❌ **Forgetting to `destroy()` on scene shutdown.**
Leaves pointer listeners and the overlay Graphics dangling. Tie it to `SHUTDOWN`.

## Deploy

`vg deploy ./dist --slug my-game` → live at `https://my-game.vibedgames.com`.
See the `deploy` skill for the full flow (use `npx vibedgames deploy` if `vg`
isn't on PATH).

## See also

- `multiplayer` (`@vibedgames/multiplayer`) — real-time sync, shared/player state, and host-authoritative logic. Pairs naturally: tint the stick/buttons to each player's color via `setTint`.
