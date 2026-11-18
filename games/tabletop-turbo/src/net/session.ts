// Tabletop Turbo's room: the SDK's MultiplayerClient is the whole session. Offline it
// is a local room of one with the same API — it hosts, writes apply locally —
// and `fallbackMs` takes it there by itself when no room admits it in time, so
// the scene runs one code path for a full grid and a solo race against bots.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** Everything but where the server is: per-game tuning (room, cap, fallbackMs). */
export type RoomOptions = Omit<MultiplayerClientOptions, "host" | "party">;

/**
 * Join the race room. Offline by intent — `?offline=1`, or `offline` for a
 * page that must never share a room (a playtest) — the client never dials.
 */
export const joinRoom = (options: RoomOptions): MultiplayerClient =>
  new MultiplayerClient({
    ...options,
    host: MULTIPLAYER_HOST,
    offline: options.offline === true || isOfflineRequested(),
    party: "vg-server",
  });
