// Multiplayer intent protocol. Guests send INTENT events; only the host mutates
// the world. The host broadcasts the world snapshot under sharedState.snap.

import { isJsonNumber, isJsonObject, isJsonString } from "./json";

import type { AbilityKey } from "../data/heroes";
import type { Order } from "../sim/types";
import type { JsonValue } from "./json";

export const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";
export const PARTY = "vg-server";
export const ROOM = "moba-default";

export type Intent =
  | { kind: "join"; defId: string }
  | { kind: "order"; order: Order }
  | { kind: "cast"; key: AbilityKey; point?: { x: number; y: number }; targetId?: string }
  | { kind: "level"; key: AbilityKey }
  | { kind: "buy"; itemId: string }
  | { kind: "useItem"; slot: number; point?: { x: number; y: number } }
  | { kind: "dash"; dx: number; dy: number };

export const INTENT_EVENT = "intent";

// ---- boundary parsing ------------------------------------------------------
// Peer payloads arrive as wire JSON; validate into a typed Intent (or null) at
// ingest instead of trusting the shape, so a malformed/version-skewed message
// is dropped rather than crashing the host's sim.
function isVec2(v: JsonValue | undefined): v is { x: number; y: number } {
  return isJsonObject(v) && isJsonNumber(v.x) && isJsonNumber(v.y);
}
function isAbilityKey(v: JsonValue | undefined): v is AbilityKey {
  return v === "Q" || v === "W" || v === "E" || v === "R";
}
function parseOrder(v: JsonValue | undefined): Order | null {
  if (!isJsonObject(v)) return null;
  switch (v.type) {
    case "idle":
      return { type: "idle" };
    case "hold":
      return { type: "hold" };
    case "lane":
      return { type: "lane" };
    case "neutral":
      return { type: "neutral" };
    case "fountain":
      return { type: "fountain" };
    case "move":
      return isVec2(v.to) ? { type: "move", to: { x: v.to.x, y: v.to.y } } : null;
    case "attackMove":
      return isVec2(v.to) ? { type: "attackMove", to: { x: v.to.x, y: v.to.y } } : null;
    case "moveDir":
      return isJsonNumber(v.dx) && isJsonNumber(v.dy)
        ? { type: "moveDir", dx: v.dx, dy: v.dy }
        : null;
    case "attackUnit":
      return isJsonString(v.targetId) ? { type: "attackUnit", targetId: v.targetId } : null;
    default:
      return null;
  }
}

/** Validate a wire payload into a typed Intent, or null if malformed. */
export function parseIntent(v: JsonValue): Intent | null {
  if (!isJsonObject(v)) return null;
  switch (v.kind) {
    case "join":
      return isJsonString(v.defId) ? { kind: "join", defId: v.defId } : null;
    case "order": {
      const order = parseOrder(v.order);
      return order ? { kind: "order", order } : null;
    }
    case "cast": {
      if (!isAbilityKey(v.key)) return null;
      const out: Intent = { kind: "cast", key: v.key };
      if (isVec2(v.point)) out.point = { x: v.point.x, y: v.point.y };
      if (isJsonString(v.targetId)) out.targetId = v.targetId;
      return out;
    }
    case "level":
      return isAbilityKey(v.key) ? { kind: "level", key: v.key } : null;
    case "buy":
      return isJsonString(v.itemId) ? { kind: "buy", itemId: v.itemId } : null;
    case "useItem": {
      if (!isJsonNumber(v.slot) || !Number.isInteger(v.slot)) return null;
      const out: Intent = { kind: "useItem", slot: v.slot };
      if (isVec2(v.point)) out.point = { x: v.point.x, y: v.point.y };
      return out;
    }
    case "dash":
      return isJsonNumber(v.dx) && isJsonNumber(v.dy) ? { kind: "dash", dx: v.dx, dy: v.dy } : null;
    default:
      return null;
  }
}
