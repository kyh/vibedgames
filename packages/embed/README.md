# @repo/embed

Tiny postMessage bridge between an embedded browser game (iframe) and the page
that wraps it. Zero dependencies, internal (not published).

The wrapper is the web app's player chrome
(`apps/web/src/components/game/game-chrome.tsx`); the game side is wired into
every example game under [`games/`](../../games).

## Game side

```ts
import { notifyGameStarted, setPauseHandlers } from "@repo/embed";

// When active play begins (past menus/start screens). Safe to call every
// round/serve/respawn — deduped until the wrapper pauses the game.
notifyGameStarted();

// Optional: let the wrapper's pause request actually freeze your game.
// Skip this for wall-clock (Date.now) driven sims and live online sessions —
// the built-in PAUSED overlay still shows; the sim just keeps running.
setPauseHandlers({
  onPause: () => game.loop.sleep(),
  onResume: () => game.loop.wake(),
});
```

On a pause request the package shows a full-screen "PAUSED — resume" overlay.
Clicking it (or releasing any key) hides the overlay, calls `onResume`, and
re-sends `game-started` so the wrapper can tuck its chrome away again.

Everything no-ops when the game runs standalone (not in an iframe).

## Overlays that a tap dismisses

Any full-screen overlay a player taps away — the pause overlay, a game's own
start screen — must be sealed, or the game underneath acts on that same tap:

```ts
import { sealPointerEvents } from "@repo/embed";

sealPointerEvents(startEl); // before wiring its own dismissal handler
```

`createPauseShell` and `createTouchControls` already do this for themselves.
The two leaks it closes, and why `preventDefault()` on the dismissal handler is
not one of the answers, are in [`src/pointer-seal.ts`](./src/pointer-seal.ts).

## Wrapper side

```ts
import { isGameStartedMessage, requestGamePause } from "@repo/embed/host";

window.addEventListener("message", (event) => {
  if (isGameStartedMessage(event.data)) hideChrome();
});

// e.g. from a pause button
requestGamePause(iframe.contentWindow);
```

## Which games can actually freeze

`setPauseHandlers` is opt-in per game because freezing is not always correct:

| Game shape                     | Pause handlers                            |
| ------------------------------ | ----------------------------------------- |
| Offline, sim-clock driven      | wire them — the sim really stops          |
| Wall-clock (`Date.now`) driven | skip — the sim would jump on resume       |
| Live online session            | skip — the room keeps running without you |

Skipping still shows the PAUSED overlay; only the freeze is declined.
