// Wrapper-side half of the protocol: recognise "game started" messages coming
// out of a game iframe, and ask the game to pause when the player wants the
// wrapper chrome back.

import { PAUSE_GAME_MESSAGE } from "./protocol";

export { GAME_STARTED_MESSAGE, isGameStartedMessage } from "./protocol";
export type { GameStartedMessage } from "./protocol";

/** Ask the embedded game to pause (it shows its own pause overlay). */
export function requestGamePause(game: Window, targetOrigin = "*"): void {
  game.postMessage({ type: PAUSE_GAME_MESSAGE }, targetOrigin);
}
