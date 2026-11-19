import { PAUSE_GAME_MESSAGE } from "./protocol";

export {
  GAME_PAUSED_MESSAGE,
  GAME_STARTED_MESSAGE,
  WRAPPER_FRAME_NAME,
  isGamePausedMessage,
  isGameStartedMessage,
} from "./protocol";

export type { GamePausedMessage, GameStartedMessage, MessageData } from "./protocol";

/** Ask the embedded game to pause (it shows its own pause overlay). */
export const requestGamePause = (game: Window, targetOrigin = "*") => {
  game.postMessage({ type: PAUSE_GAME_MESSAGE }, targetOrigin);
};
