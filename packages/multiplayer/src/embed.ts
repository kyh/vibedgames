export const GAME_STARTED_MESSAGE = "vibedgames:game-started";

export type GameStartedMessage = {
  readonly type: typeof GAME_STARTED_MESSAGE;
};

let sentGameStarted = false;

export function isGameStartedMessage(value: unknown): value is GameStartedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === GAME_STARTED_MESSAGE
  );
}

export function notifyGameStarted(): void {
  if (sentGameStarted) return;
  sentGameStarted = true;
  if (window.parent === window) return;
  window.parent.postMessage({ type: GAME_STARTED_MESSAGE }, "*");
}
