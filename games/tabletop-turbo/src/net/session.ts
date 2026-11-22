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
export const joinRoom = (options: RoomOptions) =>
  new MultiplayerClient({
    ...options,
    host: MULTIPLAYER_HOST,
    offline: options.offline === true || isOfflineRequested(),
    party: "vg-server",
  });
