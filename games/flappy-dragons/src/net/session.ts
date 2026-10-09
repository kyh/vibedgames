// The room as Flappy Dragons uses it: one @vibedgames/multiplayer client,
// polled from the scene's frame loop rather than subscribed to, and the few
// reads and writes the scene makes of it.
//
// Solo is the client's offline mode: a local room of one with the same API,
// where this player is the host and writes apply locally, so the scene runs
// one code path solo and online. `offline` never dials (`?offline=1`, a
// playtest); `fallbackMs` goes offline when no room has admitted the client
// within that many ms of rendered frames, so the game still plays when the
// party server is out of reach. Once a room has admitted the client, a drop is
// `reconnecting` (the seat is held while the socket redials), never solo.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type {
  JsonRecord,
  JsonValue,
  MultiplayerConnectionStatus,
  Player,
  PlayerMap,
} from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = JsonValue | undefined;

// Wire-JSON narrowing helpers. Runtime `typeof` is banned by the lint, so these
// use typeof-free checks; JSON can only carry finite numbers, so Number.isFinite
// is the exact number test.
export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";
export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);
export const isJsonString = (v: WireField): v is string => String(v) === v;

export interface NetSessionOptions {
  room: string;
  maxPlayers?: number;
  /** Go solo when no room has admitted the client within this long (ms of rendered frames). */
  fallbackMs: number;
  /**
   * Solo from the first frame: the client never dials. A playtest runs so,
   * and must never join (or stage state into) the shared public room.
   */
  offline: boolean;
}

export class NetSession {
  private readonly client: MultiplayerClient;

  constructor(opts: NetSessionOptions) {
    this.client = new MultiplayerClient({
      fallbackMs: opts.fallbackMs,
      host: MULTIPLAYER_HOST,
      maxPlayers: opts.maxPlayers,
      // Offline by intent (`?offline=1`, a playtest) never dials rather than
      // leaning on the fallback: a refused handshake logs a console error the
      // page cannot suppress, and the game would wait out `fallbackMs` first.
      offline: opts.offline || isOfflineRequested(),
      party: "vg-server",
      room: opts.room,
    });
  }

  /**
   * `connecting` until a room admits the client, `connected` in it,
   * `reconnecting` through a drop after that, `offline` solo.
   */
  get connectionStatus(): MultiplayerConnectionStatus {
    return this.client.connectionStatus;
  }

  /** Solo, this player is the room, so its host. */
  get isHost(): boolean {
    return this.client.isHost;
  }

  get playerId(): string | null {
    return this.client.playerId;
  }

  get players(): PlayerMap {
    return this.client.players;
  }

  get sharedState(): JsonRecord {
    return this.client.sharedState;
  }

  /**
   * The room's clock (ms): the party server's, measured from here, so a stamp
   * means the same moment to every player and outlives the host. Null until
   * the first time probe returns — the SDK reads the local clock until then,
   * and a stamp from it would be garbage to everyone else. Offline the room
   * is this client alone, so its clock is ready from the start. Pass the
   * frame's timestamp, so that everything stamped or drawn in one frame
   * shares one instant.
   */
  serverNow(localNow?: number): number | null {
    const { client } = this;
    return client.serverClock.synced ? client.serverNow(localNow) : null;
  }

  /** The other player in the room, or null when alone. */
  otherPlayer(): Player | null {
    const me = this.client.playerId;
    for (const [id, p] of Object.entries(this.client.players)) {
      if (id !== me) {
        return p;
      }
    }
    return null;
  }

  /** Per-player state shallow-merges (last write wins per field). */
  updateMyState(patch: JsonRecord): void {
    this.client.updateMyState(patch);
  }

  /** Shared-state patch shallow-merges; host-only on the server. */
  patchShared(patch: JsonRecord): void {
    this.client.updateSharedState(patch);
  }

  /**
   * Leave the room — the server frees the seat at once — and play on solo
   * from the room's world. Already offline, nothing happens.
   */
  goOffline(): void {
    this.client.goOffline();
  }

  destroy(): void {
    this.client.destroy();
  }
}
