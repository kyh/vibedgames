// Pacman's room: the SDK's MultiplayerClient is the whole session. Offline it
// is a local room of one with the same API — it hosts, writes apply locally,
// events and host intents loop back, claims are granted at once — and
// `fallbackMs` takes it there by itself when no room admits it in time, so the
// scene runs one code path for a race and a solo game. This file knows where
// the party server is and when the page is offline by intent, plus the
// wire-JSON narrowing the scene reads state with.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, MultiplayerClientOptions } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** Everything but where the server is: per-game tuning (room, cap, rules, fallbackMs). */
export type RoomOptions = Omit<MultiplayerClientOptions, "host" | "party">;

/**
 * Join pacman's room. Offline by intent — `?offline=1`, or `offline` for a
 * page that must never share a room (a playtest) — the client never dials.
 */
export const joinRoom = (options: RoomOptions): MultiplayerClient =>
  new MultiplayerClient({
    ...options,
    host: MULTIPLAYER_HOST,
    offline: options.offline === true || isOfflineRequested(),
    party: "vg-server",
  });

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = JsonValue | undefined;

// Wire-JSON narrowing helpers. Runtime `typeof` is banned by the lint, so these
// use typeof-free checks; JSON can only carry finite numbers, so Number.isFinite
// is the exact number test.
export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";
export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);
