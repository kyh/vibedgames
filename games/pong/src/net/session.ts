import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, Player, PlayerMap, TickInfo } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = JsonValue | undefined;

export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";

export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);
export const isJsonString = (v: WireField): v is string => String(v) === v;

export interface NetSessionOptions {
  room: string;
  maxPlayers?: number;
  /** Play offline when no room has admitted this client this long (ms) after its first frame. */
  fallbackMs: number;
  /** Run the room on a server tick (Hz) — a room rule, so every client passes the same. */
  tickRate?: number;
  onEvent?: (event: string, payload: JsonValue, from: string) => void;
  /** Each server tick, in order (tick rooms only; offline never ticks). */
  onTick?: (tick: TickInfo) => void;
}

export class NetSession {
  /** The room. Public for its own verbs, and for the two-client harness
   *  (tools/two-client.mts), which drops and redials its socket. */
  readonly client: MultiplayerClient;
  private otherScanned: PlayerMap | null = null;
  private other: Player | null = null;

  constructor(opts: NetSessionOptions) {
    this.client = new MultiplayerClient({
      fallbackMs: opts.fallbackMs,
      host: MULTIPLAYER_HOST,
      maxPlayers: opts.maxPlayers,
      offline: isOfflineRequested(),
      onEvent: opts.onEvent,
      onTick: opts.onTick,
      party: "vg-server",
      room: opts.room,
      tickRate: opts.tickRate,
    });
  }

  /** "connecting" until a room admits this client (an overflow redirect
   *  starts that over), "reconnecting" through a drop after admission, and
   *  "offline" for good once it plays alone. */
  get connectionStatus() {
    return this.client.connectionStatus;
  }

  /** True offline too: a room of one is its own host. */
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

  /** The other player in the room, or null when alone (offline, always).
   *  Scanned once per roster change, not per call: the client swaps in a
   *  fresh player map on every sync/join/leave/state message, and a scene
   *  asks several times a frame. */
  otherPlayer() {
    const { players, playerId } = this.client;

    if (players !== this.otherScanned) {
      this.otherScanned = players;
      this.other = null;

      for (const [id, p] of Object.entries(players)) {
        if (id !== playerId) {
          this.other = p;
          break;
        }
      }
    }

    return this.other;
  }

  /** The room's tick clock, or null (not yet admitted, or offline). */
  get tickClock() {
    return this.client.tickClock;
  }

  /** True once serverNow() means something. Offline the local clock is the
   *  room's, so it reads true there too — where no tick clock runs. */
  get clockSynced() {
    return this.client.serverClock.synced;
  }

  /** Server time now (ms since the epoch). */
  serverNow() {
    return this.client.serverNow();
  }

  /** Fastest recent round trip to the server (ms); NaN until measured. */
  get rtt() {
    return this.client.rtt;
  }

  /** Every player's held input as of tick `n` (default: the last tick), or null outside the history. */
  tickInputs(n?: number) {
    return this.client.tickInputs(n);
  }

  /** This player's input from tick `n` on (held until the next send). */
  sendInput(input: JsonValue, n?: number) {
    this.client.sendInput(input, n);
  }
}
