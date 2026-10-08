// Netcode protocol. Guests send intents to the host alone; only the host runs
// the sim and publishes it under a few shared-state keys (see snapshot.ts).
// Every guest intent after `join` carries a sequence number, and the host
// reports per guest body which one it last applied and for how long, so a
// guest compares its prediction with the host at the matching moment rather
// than at "now".
import type { BrawlerId } from "../config";

export const PARTY = "vg-server";
/** Frames stamped with server time make these rooms incompatible with earlier clients. */
export const ROOM_PREFIX = "showdown-v5-";
export const INTENT_EVENT = "intent";
/** Host snapshot rate. */
export const SNAPSHOT_HZ = 30;
/** Most input messages a guest sends per second. */
export const INPUT_HZ = 30;
/**
 * Remote bodies render this far behind the newest frame that could have
 * arrived by now: one snapshot interval plus arrival jitter. The relay's own
 * latency is learned from arrivals (`FrameClock`), not budgeted here.
 */
export const INTERP_DELAY_MS = 100;
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

/** An action the host must play on the sender's body; `dir`/`look` are quantized (see input-intent.ts). */
export type Intent =
  | { kind: "join"; kit: BrawlerId; name: string }
  | { kind: "input"; seq: number; dir: number; look: number | null }
  | { kind: "attack"; seq: number; dx: number; dz: number; x: number; z: number }
  | { kind: "super"; seq: number; dx: number; dz: number; x: number; z: number }
  | { kind: "evade"; seq: number; dx: number; dz: number };

export type SequencedIntent = Exclude<Intent, { kind: "join" }>;
