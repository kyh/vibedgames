// Where the party server is, and which room this tab joins once it deploys
// into deathmatch. A squad code (`?room=dock7`) names a private room;
// otherwise the lobby quick-matches into the fullest open public room.
// `?offline=1` (or a playtest) never dials, and
// `fallbackMs` drops to solo when no room answers — offline the client is a
// local room of one with the same API, so the game runs one code path.
import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient, quickMatch } from "@vibedgames/multiplayer";
import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";

import { FALLBACK_MS, LOBBY, MAX_PLAYERS, PARTY, roomId } from "./protocol";

/** Dev-only `?party=8788` or `?party=http://host:port` for a local party server. */
const devPartyHost = (params: URLSearchParams): string | null => {
  const raw = params.get("party");
  if (!raw) {
    return null;
  }
  return /^\d+$/u.test(raw) ? `http://localhost:${raw}` : raw;
};

const partyHost = (params: URLSearchParams): string =>
  (import.meta.env.DEV ? devPartyHost(params) : null) ??
  (import.meta.env.DEV ? "http://localhost:8787" : "https://party.vibedgames.com");

type ClientEvents = Pick<MultiplayerClientOptions, "onEvent">;

/** Open this tab's room. Resolves offline at once when play must stay solo. */
export const openRoom = async (
  params: URLSearchParams,
  options: ClientEvents & { solo: boolean },
): Promise<MultiplayerClient> => {
  const { onEvent } = options;
  const host = partyHost(params);
  const base = { fallbackMs: FALLBACK_MS, host, maxPlayers: MAX_PLAYERS, onEvent, party: PARTY };
  if (options.solo || isOfflineRequested()) {
    return new MultiplayerClient({ ...base, offline: true, room: roomId("solo") });
  }
  const code = params.get("room");
  if (code) {
    return new MultiplayerClient({ ...base, room: roomId(code) });
  }
  let room = roomId("public");
  try {
    room = await quickMatch({ host, lobby: LOBBY, maxPlayers: MAX_PLAYERS });
  } catch {
    // The lobby is unreachable: the public room's own fallback decides.
  }
  return new MultiplayerClient({ ...base, lobby: LOBBY, room });
};
