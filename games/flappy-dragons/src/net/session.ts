import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = JsonValue | undefined;

export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";

export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

export const isJsonString = (v: WireField): v is string =>
  Object.prototype.toString.call(v) === "[object String]";

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
  readonly client: MultiplayerClient;

  constructor(opts: NetSessionOptions) {
    this.client = new MultiplayerClient({
      fallbackMs: opts.fallbackMs,
      host: MULTIPLAYER_HOST,
      maxPlayers: opts.maxPlayers,
      offline: opts.offline || isOfflineRequested(),
      party: "vg-server",
      room: opts.room,
    });
  }

  /**
   * `connecting` until a room admits the client, `connected` in it,
   * `reconnecting` through a drop after that, `offline` solo.
   */
  get connectionStatus() {
    return this.client.connectionStatus;
  }

  /** Solo, this player is the room, so its host. */
  get isHost() {
    return this.client.isHost;
  }

  get playerId() {
    return this.client.playerId;
  }

  get players() {
    return this.client.players;
  }

  get sharedState() {
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
  serverNow(localNow?: number) {
    const { client } = this;

    return client.serverClock.synced ? client.serverNow(localNow) : null;
  }

  /**
   * Hear every change the client sees, between frames too: the scene polls
   * the room each frame, but a drop and the reconnect after it can both land
   * while the tab is hidden and runs none. Returns the unsubscribe.
   */
  subscribe(listener: () => void) {
    return this.client.subscribe(listener);
  }

  /** The other player in the room, or null when alone. */
  otherPlayer() {
    const me = this.client.playerId;

    for (const [id, p] of Object.entries(this.client.players)) {
      if (id !== me) {
        return p;
      }
    }

    return null;
  }

  /** Per-player state shallow-merges (last write wins per field). */
  updateMyState(patch: JsonRecord) {
    this.client.updateMyState(patch);
  }

  /** Shared-state patch shallow-merges; host-only on the server. */
  patchShared(patch: JsonRecord) {
    this.client.updateSharedState(patch);
  }

  /**
   * Leave the room — the server frees the seat at once — and play on solo
   * from the room's world. Already offline, nothing happens.
   */
  goOffline() {
    this.client.goOffline();
  }

  destroy() {
    this.client.destroy();
  }
}
