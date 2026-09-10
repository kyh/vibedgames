// Netcode protocol. Guests send INTENT events; only the host mutates the world
// and broadcasts the snapshot under sharedState.snap. Mirrors games/moba.
import type { AbilityKey } from "../sim/types";

/**
 * Dev-only override for the party host: `?party=8788` (port) or
 * `?party=http://host:port`. Lets QA point at a party server on a
 * non-default port without rebuilding. Ignored in production builds.
 */
const devPartyHost = (): string => {
  const fallback = "http://localhost:8787";
  if (typeof window === "undefined") {
    return fallback;
  }
  const p = new URLSearchParams(location.search).get("party");
  if (!p) {
    return fallback;
  }
  return /^https?:\/\//u.test(p) ? p : `http://localhost:${p}`;
};

export const MULTIPLAYER_HOST = import.meta.env.DEV
  ? devPartyHost()
  : "https://vibedgames-party.kyh.workers.dev";
export const PARTY = "vg-server";
export const ROOM_PREFIX = "battle-arena-";
export const INTENT_EVENT = "intent";

/** Build the PartyServer room id from a short lobby code. */
export const roomId = (code: string): string =>
  ROOM_PREFIX +
  (code || "public")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 12);

export type Intent =
  | { kind: "join"; champId: string; name: string }
  | { kind: "input"; mx: number; my: number; ax: number; ay: number; attack: boolean }
  | { kind: "cast"; key: AbilityKey; px: number; py: number; ax: number; ay: number }
  | { kind: "buy"; itemId: string }
  | { kind: "useItem"; slot: number; px: number; py: number }
  | { kind: "jump" };
