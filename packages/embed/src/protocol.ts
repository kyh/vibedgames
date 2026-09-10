// postMessage protocol between an embedded game (iframe) and its wrapper page.
// Payloads carry no data beyond the type tag, so they are safe to post with a
// "*" target origin; receivers still validate origins where it matters.

export const GAME_STARTED_MESSAGE = "vibedgames:game-started";
export const PAUSE_GAME_MESSAGE = "vibedgames:pause-game";
export const GAME_PAUSED_MESSAGE = "vibedgames:game-paused";

/** Game → wrapper: active play began (or resumed) — hide the wrapper chrome. */
export interface GameStartedMessage {
  readonly type: typeof GAME_STARTED_MESSAGE;
}

/** Wrapper → game: the player asked for the wrapper back — pause the game. */
export interface PauseGameMessage {
  readonly type: typeof PAUSE_GAME_MESSAGE;
}

/** Game → wrapper: the game paused itself (Escape) — show the wrapper chrome. */
export interface GamePausedMessage {
  readonly type: typeof GAME_PAUSED_MESSAGE;
}

/** What `MessageEvent.data` can carry over this protocol — plain JSON. */
export type MessageData =
  | string
  | number
  | boolean
  | null
  | MessageData[]
  | { [key: string]: MessageData };

/** The one field every message on this protocol carries. */
interface TaggedMessage {
  readonly type: string;
}

// The guards take `unknown` because a message crosses an origin boundary: the
// sender is free to post anything, so nothing about `event.data` is known until
// this has picked the tag out of it.
const hasType = (value: unknown, type: string): value is TaggedMessage =>
  value instanceof Object && !Array.isArray(value) && "type" in value && value.type === type;

export const isGameStartedMessage = (value: unknown): value is GameStartedMessage =>
  hasType(value, GAME_STARTED_MESSAGE);

export const isPauseGameMessage = (value: unknown): value is PauseGameMessage =>
  hasType(value, PAUSE_GAME_MESSAGE);

export const isGamePausedMessage = (value: unknown): value is GamePausedMessage =>
  hasType(value, GAME_PAUSED_MESSAGE);
