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
) =>
  new MultiplayerClient({
    ...options,
    host: MULTIPLAYER_HOST,
    offline: isOfflineRequested(),
    party: "vg-server",
  });
