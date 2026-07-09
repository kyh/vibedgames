// postMessage protocol between an embedded game (iframe) and its wrapper page.
// Payloads carry no data beyond the type tag, so they are safe to post with a
// "*" target origin; receivers still validate origins where it matters.

export const GAME_STARTED_MESSAGE = "vibedgames:game-started";
export const PAUSE_GAME_MESSAGE = "vibedgames:pause-game";
export const GAME_PAUSED_MESSAGE = "vibedgames:game-paused";

/** Game → wrapper: active play began (or resumed) — hide the wrapper chrome. */
export type GameStartedMessage = {
  readonly type: typeof GAME_STARTED_MESSAGE;
};

/** Wrapper → game: the player asked for the wrapper back — pause the game. */
export type PauseGameMessage = {
  readonly type: typeof PAUSE_GAME_MESSAGE;
};

/** Game → wrapper: the game paused itself (Escape) — show the wrapper chrome. */
export type GamePausedMessage = {
  readonly type: typeof GAME_PAUSED_MESSAGE;
};

const hasType = (value: unknown, type: string): boolean =>
  typeof value === "object" && value !== null && "type" in value && value.type === type;

export function isGameStartedMessage(value: unknown): value is GameStartedMessage {
  return hasType(value, GAME_STARTED_MESSAGE);
}

export function isPauseGameMessage(value: unknown): value is PauseGameMessage {
  return hasType(value, PAUSE_GAME_MESSAGE);
}

export function isGamePausedMessage(value: unknown): value is GamePausedMessage {
  return hasType(value, GAME_PAUSED_MESSAGE);
}
