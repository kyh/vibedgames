// Pong's room over @vibedgames/multiplayer, polled from the frame loop instead
// of subscribe(). The client is the room: online, a party-server room;
// offline — by intent (`?offline=1`), by choice (a solo game leaves the room),
// or because no room admitted it within `fallbackMs` — a local room of one
// with the same API, where this client is the host and its own only player.
// So nothing here special-cases solo play. Offline there is no tick room:
// `tickClock` reads null, and the match runs on this client's own clock
// (LocalDriver).
//
// What this adds to the client: the reads the match logic makes each frame,
// the other player cached per roster, the tick-room surface a TickDriver runs
// on (TickRoom), and typed narrowing for wire JSON. Verbs that are the SDK's
// own (updateSharedState, sendToHost, goOffline, destroy) are called on
// `client` directly.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type {
  JsonRecord,
  JsonValue,
  MultiplayerConnectionStatus,
  Player,
  PlayerMap,
  TickClock,
  TickInfo,
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
   *  (tools/two-client.mjs), which drops and redials its socket. */
  readonly client: MultiplayerClient;
  private otherScanned: PlayerMap | null = null;
  private other: Player | null = null;

  constructor(opts: NetSessionOptions) {
    this.client = new MultiplayerClient({
      fallbackMs: opts.fallbackMs,
      host: MULTIPLAYER_HOST,
      maxPlayers: opts.maxPlayers,
      // Offline BY INTENT never dials, rather than leaning on a failed
      // connection: a refused handshake logs a console error the page cannot
      // suppress, and the game would sit out `fallbackMs` first.
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
  get connectionStatus(): MultiplayerConnectionStatus {
    return this.client.connectionStatus;
  }

  /** True offline too: a room of one is its own host. */
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

  /** The other player in the room, or null when alone (offline, always).
   *  Scanned once per roster change, not per call: the client swaps in a
   *  fresh player map on every sync/join/leave/state message, and a scene
   *  asks several times a frame. */
  otherPlayer(): Player | null {
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

  // -- Tick room -----------------------------------------------------------

  /** The room's tick clock, or null (not yet admitted, or offline). */
  get tickClock(): TickClock | null {
    return this.client.tickClock;
  }

  /** True once serverNow() means something. Offline the local clock is the
   *  room's, so it reads true there too — where no tick clock runs. */
  get clockSynced(): boolean {
    return this.client.serverClock.synced;
  }

  /** Server time now (ms since the epoch). */
  serverNow(): number {
    return this.client.serverNow();
  }

  /** Fastest recent round trip to the server (ms); NaN until measured. */
  get rtt(): number {
    return this.client.rtt;
  }

  /** Every player's held input as of tick `n` (default: the last tick), or null outside the history. */
  tickInputs(n?: number): Record<string, JsonValue> | null {
    return this.client.tickInputs(n);
  }

  /** This player's input from tick `n` on (held until the next send). */
  sendInput(input: JsonValue, n?: number): void {
    this.client.sendInput(input, n);
  }
}
