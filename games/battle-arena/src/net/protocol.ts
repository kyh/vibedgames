import type { AbilityKey } from "../sim/types";

const devPartyHost = () => {
  const fallback = "http://localhost:8787";

  if (typeof window === "undefined") {
    return fallback;
  }

  const p = new URLSearchParams(location.search).get("party");

  if (p === null || p === "") {
    return fallback;
  }

  return /^https?:\/\//u.test(p) ? p : `http://localhost:${p}`;
};

export const MULTIPLAYER_HOST = import.meta.env.DEV
  ? devPartyHost()
  : "https://party.vibedgames.com";

export const PARTY = "vg-server";

/** Wire-format generation, part of every room id: a tab still running an
 *  older bundle during a deploy lands in a different room, never a shared
 *  match it cannot read. Bump it with any change to frames, snapshots or input. */
export const NETCODE_VERSION = "v3";
export const ROOM_PREFIX = `battle-arena-${NETCODE_VERSION}-`;
export const INTENT_EVENT = "intent";
export const FRAME_EVENT = "frame";

/** Build the PartyServer room id from a short lobby code. */
export const roomId = (code: string) =>
  ROOM_PREFIX +
  (code || "public")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 12);

/** A cast pressed during a guest tick: key, aim direction, aim point. */
export type CastWire = [AbilityKey, number, number, number, number];

/** An item-belt slot used during a guest tick, and the aim point. */
export type ItemWire = [number, number, number];

export type Intent =
  | { kind: "join"; champId: string; name: string }
  | {
      kind: "input";
      /** Sequence number; the host acks the newest it has applied. */
      seq: number;
      /** The guest's tick counter, which schedules the input on the host. */
      tick: number;
      mx: number;
      my: number;
      ax: number;
      ay: number;
      /** Attack held — or pressed at any point during the tick. */
      atk: boolean;
      jump?: boolean;
      dash?: [number, number];
      casts?: CastWire[];
      items?: ItemWire[];
    }
  | { kind: "buy"; itemId: string };
