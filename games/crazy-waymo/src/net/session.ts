// The room connection: every driver shares one free-roam room through
// @vibedgames/multiplayer, and the scene reads the client directly each frame.
// The client also plays the room alone when it has to — offline by intent it
// never dials, and a room that has not admitted it within OFFLINE_FALLBACK_MS
// of rendered frames leaves it playing solo. Offline it is a room of one with
// the same API (this player is `OFFLINE_PLAYER_ID` and the host, the server
// clock reads the local one), so the scene runs one code path either way.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";

import { MP_INTEREST, MP_MAX_PLAYERS, OFFLINE_FALLBACK_MS } from "../shared/constants";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

export interface RoomOptions {
  /** Never dial: trailer staging and playtests, which must not show or reach
   *  live players. `?offline=1` always counts too. */
  offline: boolean;
  room: string;
}

/**
 * Join the room. Call it once the city is playable, never at boot: the
 * fallback deadline counts the frames drawn from here on, and this game draws
 * frames all through its load (world decode, physics wasm, shader warmup). On
 * a slow link the load alone would use up the deadline and strand the player
 * solo before the socket got its chance.
 */
export const connectRoom = ({ offline, room }: RoomOptions): MultiplayerClient =>
  new MultiplayerClient({
    fallbackMs: OFFLINE_FALLBACK_MS,
    host: MULTIPLAYER_HOST,
    interest: MP_INTEREST,
    maxPlayers: MP_MAX_PLAYERS,
    offline: offline || isOfflineRequested(),
    party: "vg-server",
    room,
  });

const roomStatusText = (net: MultiplayerClient): string => {
  switch (net.connectionStatus) {
    case "connecting": {
      return "CONNECTING…";
    }
    case "reconnecting": {
      return "RECONNECTING…";
    }
    case "connected": {
      const others = Object.keys(net.players).length - 1;
      return others > 0 ? `${others} ONLINE` : "";
    }
    default: {
      return "";
    }
  }
};

/**
 * The corner label (#netinfo): how many other drivers share the room, or —
 * while this client is out of it — that it is on its way in, pulsing (`wait`).
 * Connecting runs from the first dial until a room admits us or the fallback
 * gives up; reconnecting is this client's own drop, which would otherwise read
 * only as every other taxi stalling and greying out. Solo it is blank.
 */
export const showRoomStatus = (el: Element, net: MultiplayerClient): void => {
  const text = roomStatusText(net);
  if (el.textContent === text) {
    return;
  }
  el.textContent = text;
  const status = net.connectionStatus;
  el.classList.toggle("wait", status === "connecting" || status === "reconnecting");
};
