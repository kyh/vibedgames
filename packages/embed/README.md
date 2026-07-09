# @vibedgames/embed

Tiny postMessage bridge between an embedded browser game (iframe) and the page
that wraps it. Zero dependencies.

## Game side

```ts
import { notifyGameStarted, setPauseHandlers } from "@vibedgames/embed";

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

## Wrapper side

```ts
import { isGameStartedMessage, requestGamePause } from "@vibedgames/embed/host";

window.addEventListener("message", (event) => {
  if (isGameStartedMessage(event.data)) hideChrome();
});

// e.g. from a pause button
requestGamePause(iframe.contentWindow);
```
