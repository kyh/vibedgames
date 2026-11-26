import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient, quickMatch } from "@vibedgames/multiplayer";
import type { MultiplayerClientOptions } from "@vibedgames/multiplayer";

import { FALLBACK_MS, LOBBY, MAX_PLAYERS, PARTY, roomId } from "./protocol";

const devPartyHost = (params: URLSearchParams) => {
  const raw = params.get("party");

  if (raw === null || raw === "") {
    return null;
  }

  return /^\d+$/u.test(raw) ? `http://localhost:${raw}` : raw;
};

const partyHost = (params: URLSearchParams) =>
  (import.meta.env.DEV ? devPartyHost(params) : null) ??
  (import.meta.env.DEV ? "http://localhost:8787" : "https://party.vibedgames.com");

type ClientEvents = Pick<MultiplayerClientOptions, "onEvent">;

/** Open this tab's room. Resolves offline at once when play must stay solo. */
export const openRoom = async (
  params: URLSearchParams,
  options: ClientEvents & { solo: boolean },
) => {
  const { onEvent } = options;
  const host = partyHost(params);
  const base = { fallbackMs: FALLBACK_MS, host, maxPlayers: MAX_PLAYERS, onEvent, party: PARTY };

  if (options.solo || isOfflineRequested()) {
    return new MultiplayerClient({ ...base, offline: true, room: roomId("solo") });
  }

  const code = params.get("room");

  if (code !== null && code !== "") {
    return new MultiplayerClient({ ...base, room: roomId(code) });
  }

  const room = await quickMatch({ host, lobby: LOBBY, maxPlayers: MAX_PLAYERS }).catch(() =>
    roomId("public"),
  );

  return new MultiplayerClient({ ...base, lobby: LOBBY, room });
};
