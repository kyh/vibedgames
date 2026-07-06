// Multiplayer intent protocol. Guests send INTENT events; only the host mutates
// the world. The host broadcasts the world snapshot under sharedState.snap.

import type { AbilityKey } from "../data/heroes";
import type { Order } from "../sim/types";

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
// Peer payloads arrive as `unknown` over the wire; validate into a typed Intent
// (or null) at ingest instead of trusting the shape, so a malformed/version-
// skewed message is dropped rather than crashing the host's sim.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isVec2(v: unknown): v is { x: number; y: number } {
  return isRecord(v) && Number.isFinite(v.x) && Number.isFinite(v.y);
}
function isAbilityKey(v: unknown): v is AbilityKey {
  return v === "Q" || v === "W" || v === "E" || v === "R";
}
function parseOrder(v: unknown): Order | null {
  if (!isRecord(v)) return null;
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
      return typeof v.dx === "number" && typeof v.dy === "number"
        ? { type: "moveDir", dx: v.dx, dy: v.dy }
        : null;
    case "attackUnit":
      return typeof v.targetId === "string" ? { type: "attackUnit", targetId: v.targetId } : null;
    default:
      return null;
  }
}

/** Validate an unknown wire payload into a typed Intent, or null if malformed. */
export function parseIntent(v: unknown): Intent | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case "join":
      return typeof v.defId === "string" ? { kind: "join", defId: v.defId } : null;
    case "order": {
      const order = parseOrder(v.order);
      return order ? { kind: "order", order } : null;
    }
    case "cast": {
      if (!isAbilityKey(v.key)) return null;
      const out: Intent = { kind: "cast", key: v.key };
      if (isVec2(v.point)) out.point = { x: v.point.x, y: v.point.y };
      if (typeof v.targetId === "string") out.targetId = v.targetId;
      return out;
    }
    case "level":
      return isAbilityKey(v.key) ? { kind: "level", key: v.key } : null;
    case "buy":
      return typeof v.itemId === "string" ? { kind: "buy", itemId: v.itemId } : null;
    case "useItem": {
      if (typeof v.slot !== "number" || !Number.isInteger(v.slot)) return null;
      const out: Intent = { kind: "useItem", slot: v.slot };
      if (isVec2(v.point)) out.point = { x: v.point.x, y: v.point.y };
      return out;
    }
    case "dash":
      return typeof v.dx === "number" && typeof v.dy === "number"
        ? { kind: "dash", dx: v.dx, dy: v.dy }
        : null;
    default:
      return null;
  }
}
