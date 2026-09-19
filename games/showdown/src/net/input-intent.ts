import type { JsonObject, JsonValue } from "./json";
import { isJsonNumber } from "./json";

export interface InputState {
  mx: number;
  mz: number;
  look: number | null;
}

const axis = (value: JsonValue | undefined): number =>
  isJsonNumber(value) ? Math.max(-1, Math.min(1, value)) : 0;

/** Angles wrap at the boundary; absent or invalid aim releases passive facing. */
export const parseInputState = (payload: JsonObject): InputState => ({
  look: isJsonNumber(payload.look)
    ? Math.atan2(Math.sin(payload.look), Math.cos(payload.look))
    : null,
  mx: axis(payload.mx),
  mz: axis(payload.mz),
});

/** Movement and aim ownership changes are immediate; continuous aim is capped at 20 Hz. */
export const shouldSendInput = (
  previous: InputState,
  next: InputState,
  elapsedMs: number,
): boolean => {
  if (
    previous.mx !== next.mx ||
    previous.mz !== next.mz ||
    (previous.look === null) !== (next.look === null)
  ) {
    return true;
  }
  if (previous.look !== next.look && elapsedMs >= 50) {
    return true;
  }
  return (next.mx !== 0 || next.mz !== 0 || next.look !== null) && elapsedMs >= 500;
};
