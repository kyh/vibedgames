import { PartySocket } from "partysocket";

import type { JsonRecord, JsonValue, RoomListing } from "./types.js";
import { LOBBY_PARTY } from "./types.js";

/** Where a lobby lives: the party server's host, and the lobby's name. */
export interface LobbyOptions {
  host: string;
  lobby: string;
}

const LOBBY_NAME = /^[\w-]{1,64}$/u;

/** Whether `name` can name a lobby: letters, digits, `-` and `_`, up to 64. */
export const isLobbyName = (name: string): boolean => LOBBY_NAME.test(name);

const asRecord = (value: JsonValue | undefined): JsonRecord | null =>
  value instanceof Object && !Array.isArray(value) ? value : null;

/** A lobby's answer, read as JSON; throws with the lobby's name on anything else. */
const ask = async (options: LobbyOptions, init?: RequestInit): Promise<JsonRecord> => {
  if (!isLobbyName(options.lobby)) {
    throw new Error(
      `"${options.lobby}" is not a lobby name: use letters, digits, "-" and "_", up to 64`,
    );
  }
  const response = await PartySocket.fetch(
    { host: options.host, party: LOBBY_PARTY, room: options.lobby },
    init,
  );
  if (!response.ok) {
    throw new Error(`lobby "${options.lobby}" answered ${response.status}`);
  }
  // SAFETY: JSON.parse output is a JSON value by construction.
  const body = asRecord(JSON.parse(await response.text()) as JsonValue);
  if (body === null) {
    throw new Error(`lobby "${options.lobby}" answered something other than an object`);
  }
  return body;
};

const readListing = (value: JsonValue): RoomListing | null => {
  const entry = asRecord(value);
  const room = entry?.room;
  const players = entry?.players;
  if (!entry || String(room) !== room || !Number.isSafeInteger(players)) {
    return null;
  }
  return {
    capacity: Number.isSafeInteger(entry.capacity) ? Number(entry.capacity) : null,
    locked: entry.locked === true,
    meta: asRecord(entry.meta) ?? {},
    players: Number(players),
    room: String(room),
  };
};

/**
 * The rooms listed in a lobby, fullest first: each one's id, players, cap,
 * lock and meta. A locked room is listed, so a lobby can show a match in
 * progress, but no quick match sends anyone to it.
 */
export const listRooms = async (options: LobbyOptions): Promise<RoomListing[]> => {
  const { rooms } = await ask(options);
  if (!Array.isArray(rooms)) {
    throw new TypeError(`lobby "${options.lobby}" answered without a room list`);
  }
  return rooms.flatMap((room) => readListing(room) ?? []);
};

/**
 * A room id to join from a lobby: the fullest unlocked room with a free seat,
 * or a new room. The lobby holds the seat for a few seconds, so players
 * matching at once fill one room instead of each opening their own. Pass the
 * `maxPlayers` the client will connect with, so a new room counts as full
 * before its players arrive; then connect with that `room`, the same `lobby`
 * and `maxPlayers`.
 */
export const quickMatch = async (
  options: LobbyOptions & { maxPlayers?: number },
): Promise<string> => {
  const { room } = await ask(options, {
    body: JSON.stringify({ maxPlayers: options.maxPlayers ?? null }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (String(room) !== room) {
    throw new TypeError(`lobby "${options.lobby}" answered without a room`);
  }
  return String(room);
};
