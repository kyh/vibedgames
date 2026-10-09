// The co-op farm's connection: the one place the party host lives. The client
// is the whole session. Offline — by intent (`?offline=1`), or because no room
// admitted it within `fallbackMs` of play — it is a local room of one with the
// same API: it hosts, its writes apply locally and `serverNow()` reads the
// local clock. Once a room has admitted it, a drop is "reconnecting" (the seat
// is held while the socket redials), never a fallback to solo.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** Join `options.room` — or, when the page asked to play offline, never dial:
 *  a refused handshake logs a console error the page cannot suppress. */
export const openSession = (
  options: Omit<MultiplayerClientOptions, "host" | "offline" | "party">,
): MultiplayerClient =>
  new MultiplayerClient({
    ...options,
    host: MULTIPLAYER_HOST,
    offline: isOfflineRequested(),
    party: "vg-server",
  });
