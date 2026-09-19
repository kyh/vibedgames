# @vibedgames/playtest

Make a browser game playtestable. A game publishes three window globals — live
diagnostics, test hooks, and a control manifest — and `vg playtest` can then
measure it, script it, and hand the controls to a model (`vg playtest run`)
instead of guessing from pixels. This package types those globals and
publishes them; it has no runtime dependency and no engine opinion (Phaser,
Three.js, plain canvas all the same).

The globals **are** the contract. A game can set them by hand and skip this
package entirely — the types are the reason to install it, plus the one
reflex everyone writes (`pointerTracker`).

## Install

```sh
npm install @vibedgames/playtest
```

## Quickstart

```ts
import {
  isPlaytestRequested,
  pointerTracker,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";

// 1. What a playtest reads every frame. A live getter: `read()` runs on access.
publishDiagnostics(() => ({
  frame: game.frame,
  score: game.score,
  complete: game.over,
  player: { x: game.player.x, y: game.player.y },
  // What the model decides FROM — relative vectors beat absolute lists:
  nearestHazard: game.nearestHazard(), // { dx, dy, kind } | null
  goalDirection: { dx: game.flag.x - game.player.x, dy: 0 },
  canJump: game.player.grounded,
}));

// 2. + 3. Gated, so players never see them; `vg playtest run --url '…?test=1'` does.
if (import.meta.env.DEV || isPlaytestRequested()) {
  publishTestHooks({
    seed: (n) => game.restart(n), // reseed AND restart
    setState: (name) => {
      game.jumpTo(name); // 'active-play' skips the menu
      return { state: name };
    },
  });

  publishPlaytest({
    goal: "Cross the level to the flag on the right. Pits and spikes kill; jump them (nearestHazard.dx says how far). Coins raise the score.",
    move: {
      left: { description: "Run left", keys: ["ArrowLeft"] },
      right: { description: "Run right (towards the flag)", keys: ["ArrowRight"] },
      right_jump: {
        description: "Run right while jumping — clears pits",
        keys: ["ArrowRight", "Space"],
      },
    },
    actions: {
      fire: { description: "fire the blaster at an enemy in front", keys: ["KeyX"] },
    },
  });
}
```

Then:

```sh
vg playtest run --url http://localhost:5173
```

## The three globals

| Global                        | Publisher              | Read by                                                      |
| ----------------------------- | ---------------------- | ------------------------------------------------------------ |
| `window.__GAME_DIAGNOSTICS__` | `publishDiagnostics()` | every playtest, every frame; sent to the model each decision |
| `window.__GAME_TEST_HOOKS__`  | `publishTestHooks()`   | `seed`, `setState`, screenshot freeze                        |
| `window.__GAME_PLAYTEST__`    | `publishPlaytest()`    | `vg playtest run`, at launch (no `--controls` file needed)   |

`publishPlaytest` checks the manifest the way `vg playtest run` would — a
missing description, a pointer given in pixels instead of viewport fractions,
an action with no keys — and throws in the game's own console, so the mistake
shows up before the CLI is involved.

**A game in world units sets `minDisplacement`.** The run's input-alive gate
is "the player moved more than 5 in one decision", which is a pixel-scale
number. A Three.js court a few units wide never moves 5 of anything, and fails
as "player did not respond to input" while playing perfectly — give the
manifest `minDisplacement: 0.05` (a fraction of what one decision's hold moves
the player, in the units of `player.x/y/z`).

## Reflexes: the fast-game path

A model decides a few times a second. For a game that needs 60 fps hands, give
the move that needs speed a `reflex`: while it is the model's current intent,
`vg playtest run` calls it every frame with the live diagnostics and holds what
it returns. The model still chooses _when_.

```ts
import { pointerTracker } from "@vibedgames/playtest";

const track = pointerTracker(); // walks a cursor along x by a signed error

publishPlaytest<PongDiagnostics>({
  goal: "You control the bottom paddle; it follows the pointer's x. Return every ball.",
  move: {
    centre: { description: "Park the paddle in the centre", pointer: { x: 0.5, y: 0.5 } },
    track_ball: {
      description: "Follow the ball — keep the paddle under it every frame",
      reflex: (game) => (game ? track(game.ball.x - game.player.x) : null),
    },
  },
});
```

The generic parameter types the reflex's `game` argument as your own
diagnostics shape. `pointerTracker` takes `{ gain, maxStep, min, max, start, y, down }`.

## Helpers for reflexes

- `pointerTracker(options)` — walk the cursor along one axis by a signed error each frame (a paddle under a ball).
- `pointerAim(dx, dy, { down, radius })` — park the cursor in a target's direction, for camera-follow games where the cursor is a heading (a ship that flies towards the mouse). Direction only, so no viewport size or zoom is needed.
- `keyTapper({ downFrames, upFrames })` — for verbs the game reads on the keydown edge (step a cell, rotate, flap). A key returned every frame is one long press; `tap(["Space"])` alternates press and release so each cycle is a fresh keydown. Pass `[]` when there is nothing to tap.

A reflex that returns `null` holds nothing.

## API

- `publishDiagnostics(read, target?)` — installs `__GAME_DIAGNOSTICS__` as a getter over `read`.
- `publishTestHooks(hooks, target?)` — sets `__GAME_TEST_HOOKS__`; returns `hooks`.
- `publishPlaytest(manifest, target?)` — validates and sets `__GAME_PLAYTEST__`; returns `manifest`.
- `definePlaytest(manifest)` — identity, for typing a manifest built elsewhere.
- `isPlaytestRequested(search?)` — `?test=1` is present.
- `pointerTracker(options?)` — `(error) => ReflexInputs`, clamped and rate-limited.
- Types: `Diagnostics`, `TestHooks`, `PlaytestManifest`, `MoveOption`, `ActionOption`, `Reflex`, `ReflexInputs`, `PlaytestPointer`, `PlaytestTarget`.

`target` defaults to `globalThis`; pass a plain object in tests.

## Where the rules live

The full contract — field meanings, what makes `seed` honest, how the model
reads a run — is in the `playtest` skill that ships with the `vibedgames` CLI
(`vg init` installs it). This README is the API; that skill is the method.
