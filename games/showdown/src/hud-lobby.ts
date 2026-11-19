import { isOfflineRequested } from "@repo/embed";

import { mustGet, mustGetInput } from "./dom";
import type { Game } from "./game";
import { MAX_NAME_LENGTH, roomId } from "./net/protocol";

const NAME_KEY = "showdown-name";
const ROOM_KEY = "showdown-room";
const DEFAULT_NAME = "Player";

const readPreference = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const savePreference = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

/** A display name for the wire: trimmed, capped, never empty. */
export const cleanName = (raw: string | null | undefined) => {
  const name = (raw ?? "").trim().slice(0, MAX_NAME_LENGTH);

  return name || DEFAULT_NAME;
};

/** Player name for a quick-start boot: `?name` → localStorage → "Player". */
export const chosenName = (params: URLSearchParams) =>
  cleanName(params.get("name") ?? readPreference(NAME_KEY));

const readLobbyName = () => {
  const name = cleanName(mustGetInput("lobby-name").value);
  savePreference(NAME_KEY, name);

  return name;
};

const readLobbyRoom = () => {
  const code = mustGetInput("lobby-room").value.trim();
  savePreference(ROOM_KEY, code);

  return roomId(code);
};

/** Wire the title screen's lobby controls. `?offline=1` drops the online affordances. */
export const buildLobby = (game: Game, params: URLSearchParams) => {
  const nameInput = mustGetInput("lobby-name");
  nameInput.value = cleanName(params.get("name") ?? readPreference(NAME_KEY) ?? "");
  const roomInput = mustGetInput("lobby-room");
  roomInput.value = params.get("room") ?? readPreference(ROOM_KEY) ?? "";
  const online = mustGet("play-online");

  if (isOfflineRequested()) {
    mustGet("lobby-online").hidden = true;

    return;
  }

  online.addEventListener("click", () => {
    game.audio.unlock();
    game.startOnline({ name: readLobbyName(), room: readLobbyRoom() });
  });

  for (const input of [nameInput, roomInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        online.click();
      }
    });
  }
};

/** The connection pill in the top bar; `null` hides it. */
export const setNetStatus = (text: string | null) => {
  const el = mustGet("net-status");
  el.hidden = text === null;

  if (text !== null && el.textContent !== text) {
    el.textContent = text;
  }
};

/** The spectator strip under the top bar; `null` hides it. */
export const setSpectateCopy = (text: string | null) => {
  const el = mustGet("spectate");
  el.hidden = text === null;

  if (text !== null && el.textContent !== text) {
    el.textContent = text;
  }
};

export type ResultMode = "solo" | "host" | "guest";

/** Solo and the host may restart; a guest waits for the host's next brawl. */
export const setResultMode = (mode: ResultMode) => {
  mustGet("again").hidden = mode === "guest";
  mustGet("result-wait").hidden = mode === "solo";
  mustGet("to-menu").textContent = mode === "solo" ? "CHANGE BRAWLER" : "LEAVE ROOM";
};

/** The result screen's countdown / waiting line. */
export const setResultWait = (text: string) => {
  const el = mustGet("result-wait");

  if (el.textContent !== text) {
    el.textContent = text;
  }
};
