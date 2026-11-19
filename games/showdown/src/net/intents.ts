import { isBrawlerId } from "../config";
import type { JsonValue } from "../json";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import { parseInputState } from "./input-intent";
import { MAX_NAME_LENGTH } from "./protocol";
import type { Intent } from "./protocol";

const MAX_COORD = 40;

const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));
const clampCoord = (n: number) => Math.max(-MAX_COORD, Math.min(MAX_COORD, n));
const num = (v: JsonValue | undefined) => (isJsonNumber(v) ? v : 0);

const isSeq = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isSafeInteger(v) && v >= 1;

/** Parse a wire intent field by field; a malformed or spoofed shape yields null. */
export const parseIntent: (payload: JsonValue) => Intent | null = (payload) => {
  if (!isJsonObject(payload)) {
    return null;
  }

  if (payload["kind"] === "join") {
    const { kit, name } = payload;

    if (!isJsonString(kit) || !isBrawlerId(kit) || !isJsonString(name)) {
      return null;
    }

    return { kind: "join", kit, name: name.slice(0, MAX_NAME_LENGTH) };
  }

  const { seq } = payload;

  if (!isSeq(seq)) {
    return null;
  }

  switch (payload["kind"]) {
    case "input": {
      return { ...parseInputState(payload), kind: "input", seq };
    }

    case "evade": {
      const { dx, dz } = payload;

      if (!isJsonNumber(dx) || !isJsonNumber(dz)) {
        return null;
      }

      return { dx: clamp1(dx), dz: clamp1(dz), kind: "evade", seq };
    }

    case "attack":
    case "super": {
      return {
        dx: clamp1(num(payload["dx"])),
        dz: clamp1(num(payload["dz"])),
        kind: payload["kind"],
        seq,
        x: clampCoord(num(payload["x"])),
        z: clampCoord(num(payload["z"])),
      };
    }

    default: {
      return null;
    }
  }
};
