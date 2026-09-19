// Netcode protocol. Guests send INTENT events; only the host runs the sim and
// broadcasts the snapshot under sharedState.snap. Mirrors games/battle-arena.
import type { BrawlerId } from "../config";

/**
 * Dev-only override for the party host: `?party=8788` (port) or
 * `?party=http://host:port`, so QA can point at a party server on a
 * non-default port without rebuilding. Ignored in production builds.
 */
const devPartyHost = (): string => {
  const fallback = "http://localhost:8787";
  if (!("location" in globalThis)) {
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
export const ROOM_PREFIX = "showdown-";
export const INTENT_EVENT = "intent";
/** Host broadcast rate. */
export const SNAPSHOT_HZ = 15;
/** Seats per room: the host's roster (bots + 1); overflow rooms are automatic. */
export const MAX_PLAYERS = 8;
/** Longest a name travels on the wire. */
export const MAX_NAME_LENGTH = 12;

/** Build the PartyServer room id from a short lobby code. */
export const roomId = (code: string): string =>
  ROOM_PREFIX +
  (code || "public")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 12);

/** Net id of a human's seat (`p:<playerId>`) — the same on every client. */
export const seatId = (playerId: string): string => `p:${playerId}`;

export type Intent =
  | { kind: "join"; kit: BrawlerId; name: string }
  | { kind: "input"; mx: number; mz: number }
  | { kind: "attack"; dx: number; dz: number; x: number; z: number }
  | { kind: "super"; dx: number; dz: number; x: number; z: number }
  | { kind: "again" };
