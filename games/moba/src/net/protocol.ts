// Multiplayer protocol. Guests send INTENT events to the host; only the host
// mutates the world. The host streams a TICK event per sim step (what changed,
// see net/stream.ts) and keeps a full keyframe under sharedState.snap for late
// joiners and host handover.

import { isJsonNumber, isJsonObject, isJsonString } from "./json";

import type { AbilityKey } from "../data/heroes";
import type { Order } from "../sim/types";
import type { JsonObject, JsonValue } from "./json";

/** Read when a client connects, not at import, so the pure protocol below
 *  also loads under node for the netcode tests. */
export const multiplayerHost = (): string =>
  import.meta.env.DEV ? "http://localhost:8787" : "https://vibedgames-party.kyh.workers.dev";
export const PARTY = "vg-server";
/** Rooms are namespaced by wire format: bump it with any change to ticks,
 *  keyframes or intents, so tabs still on an older bundle during a deploy
 *  never share a match with this one. */
const ROOM_PREFIX = "moba-v3";

/** `?room=<code>` joins a private room (play with friends, isolated test runs);
 *  anything else lands in the shared default room. */
export const roomFromLocation = (): string => {
  const code = new URLSearchParams(window.location.search).get("room") ?? "";
  return /^[\w-]{1,32}$/u.test(code) ? `${ROOM_PREFIX}-${code}` : `${ROOM_PREFIX}-default`;
};

/** Every intent but `join` may carry `seq`: the guest's input counter, which
 *  the host echoes back as the newest input it has applied to that hero, so the
 *  guest can line its prediction up with the host's copy (net/predict.ts). */
export type Intent =
  | { kind: "join"; defId: string }
  | { kind: "order"; order: Order; seq?: number }
  | {
      kind: "cast";
      key: AbilityKey;
      point?: { x: number; y: number };
      targetId?: string;
      seq?: number;
    }
  | { kind: "level"; key: AbilityKey; seq?: number }
  | { kind: "buy"; itemId: string; seq?: number }
  | { kind: "useItem"; slot: number; point?: { x: number; y: number }; seq?: number }
  | { kind: "dash"; dx: number; dy: number; seq?: number };

export const INTENT_EVENT = "intent";
export const TICK_EVENT = "tick";

// ---- boundary parsing ------------------------------------------------------
// Peer payloads arrive as wire JSON; validate into a typed Intent (or null) at
// ingest instead of trusting the shape, so a malformed/version-skewed message
// is dropped rather than crashing the host's sim.
const isVec2 = (v: JsonValue | undefined): v is { x: number; y: number } =>
  isJsonObject(v) && isJsonNumber(v.x) && isJsonNumber(v.y);
const isAbilityKey = (v: JsonValue | undefined): v is AbilityKey =>
  v === "Q" || v === "W" || v === "E" || v === "R";
const parseOrder = (v: JsonValue | undefined): Order | null => {
  if (!isJsonObject(v)) {
    return null;
  }
  switch (v.type) {
    case "idle": {
      return { type: "idle" };
    }
    case "hold": {
      return { type: "hold" };
    }
    case "lane": {
      return { type: "lane" };
    }
    case "neutral": {
      return { type: "neutral" };
    }
    case "fountain": {
      return { type: "fountain" };
    }
    case "move": {
      return isVec2(v.to) ? { to: { x: v.to.x, y: v.to.y }, type: "move" } : null;
    }
    case "attackMove": {
      return isVec2(v.to) ? { to: { x: v.to.x, y: v.to.y }, type: "attackMove" } : null;
    }
    case "moveDir": {
      return isJsonNumber(v.dx) && isJsonNumber(v.dy)
        ? { dx: v.dx, dy: v.dy, type: "moveDir" }
        : null;
    }
    case "attackUnit": {
      return isJsonString(v.targetId) ? { targetId: v.targetId, type: "attackUnit" } : null;
    }
    default: {
      return null;
    }
  }
};

const parseCast = (v: JsonObject): Intent | null => {
  if (!isAbilityKey(v.key)) {
    return null;
  }
  const out: Intent = { key: v.key, kind: "cast" };
  if (isVec2(v.point)) {
    out.point = { x: v.point.x, y: v.point.y };
  }
  if (isJsonString(v.targetId)) {
    out.targetId = v.targetId;
  }
  return out;
};

const parseUseItem = (v: JsonObject): Intent | null => {
  if (!isJsonNumber(v.slot) || !Number.isInteger(v.slot)) {
    return null;
  }
  const out: Intent = { kind: "useItem", slot: v.slot };
  if (isVec2(v.point)) {
    out.point = { x: v.point.x, y: v.point.y };
  }
  return out;
};

const isSeq = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isSafeInteger(v) && v >= 0;

const parseIntentBody = (v: JsonObject): Intent | null => {
  switch (v.kind) {
    case "join": {
      return isJsonString(v.defId) ? { defId: v.defId, kind: "join" } : null;
    }
    case "order": {
      const order = parseOrder(v.order);
      return order ? { kind: "order", order } : null;
    }
    case "cast": {
      return parseCast(v);
    }
    case "level": {
      return isAbilityKey(v.key) ? { key: v.key, kind: "level" } : null;
    }
    case "buy": {
      return isJsonString(v.itemId) ? { itemId: v.itemId, kind: "buy" } : null;
    }
    case "useItem": {
      return parseUseItem(v);
    }
    case "dash": {
      return isJsonNumber(v.dx) && isJsonNumber(v.dy) ? { dx: v.dx, dy: v.dy, kind: "dash" } : null;
    }
    default: {
      return null;
    }
  }
};

/** Validate a wire payload into a typed Intent, or null if malformed. */
export const parseIntent = (v: JsonValue): Intent | null => {
  if (!isJsonObject(v)) {
    return null;
  }
  const intent = parseIntentBody(v);
  if (intent && intent.kind !== "join" && isSeq(v.seq)) {
    intent.seq = v.seq;
  }
  return intent;
};
