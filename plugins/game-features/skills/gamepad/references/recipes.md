# Recipes

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
- Edge (place a bomb, jump once per tap): use the `onButtonDown(id)` / `onButtonUp(id)` callbacks, or poll `justPressed(id)` / `justReleased(id)` after `update()` — polling fits fixed-timestep sims where input is sampled once per tick.

## DOM adapter (Three.js / canvas / vanilla)

`attachDomGamepad` renders the stick + buttons as DOM elements in a
`pointer-events: none` overlay and listens on `window` for touch pointers
(mouse is ignored, same as Phaser). Taps on interactive elements (`button`,
`a`, inputs, `[data-gamepad-ignore]`) are left to the page, so it won't
swallow your HUD.

```ts
import { attachDomGamepad, stickDirection4 } from "@vibedgames/gamepad/dom";

const gamepad = attachDomGamepad({
  visible: "coarse", // pre-show fixed buttons on touch devices — discoverable before first touch
  buttons: [
    {
      id: "jump",
      label: "JUMP",
      position: (v) => ({ x: v.width - 72 - v.inset.right, y: v.height - 72 - v.inset.bottom }),
    },
    { id: "fire" }, // rest button: any non-stick finger
  ],
});

// in your rAF game loop:
gamepad.update(); // ALWAYS once per frame: reconcile + edges + redraw
const stick = gamepad.getStick();
if (gamepad.justPressed("jump")) jump();
if (gamepad.isButtonDown("fire")) shoot();

// on teardown:
gamepad.destroy();
```

Requirements: your game surface needs `touch-action: none` (else the browser
scrolls instead of delivering moves), and `setTint` takes a CSS color string
here (`"#22d3ee"`), not a number.

### Overlays that dismiss on tap must cancel `touchend`

A tap that dismisses a start/pause overlay leaks the browser's compatibility
mouse `click` into the canvas ~1 ms after `touchend` — by then the overlay has
stopped hit-testing, so the click re-targets to whatever is underneath and the
game sees a phantom tap (a bomb, a jump, a flap). `preventDefault()` on
`pointerup` does **not** suppress it; cancelling the `touchend` does, because
the compatibility burst is that event's default action. Register the listener
non-passive and stop propagation on every pointer/touch/mouse type too, since
Phaser listens on `window` and sees taps that miss its canvas:

```ts
overlay.addEventListener(
  "touchend",
  (e) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  },
  { passive: false },
);
```

Dismiss on `pointerup`, never on `click`; an overlay button that genuinely
needs its `click` (a "how to play" link) is the one exception — leave that
target's `touchend` uncancelled.
