// Netcode protocol. Guests send INTENT events; only the host mutates the world
// and broadcasts the snapshot under sharedState.snap. Mirrors games/moba.
import type { AbilityKey } from "../sim/types";

export const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";
export const PARTY = "vg-server";
export const ROOM_PREFIX = "battle-arena-";
export const INTENT_EVENT = "intent";

/** Build the PartyServer room id from a short lobby code. */
export function roomId(code: string): string {
  return ROOM_PREFIX + (code || "public").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
}

export type Intent =
  | { kind: "join"; champId: string; name: string }
  | { kind: "input"; mx: number; my: number; ax: number; ay: number; attack: boolean }
  | { kind: "cast"; key: AbilityKey; px: number; py: number; ax: number; ay: number }
  | { kind: "buy"; itemId: string }
  | { kind: "useItem"; slot: number; px: number; py: number }
  | { kind: "jump" }
  | { kind: "dodge"; mx: number; my: number };
