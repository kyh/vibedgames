// Thin adapter over @vibedgames/multiplayer for games that poll from their own
// frame loop (a Phaser scene's update() or a plain RAF loop) instead of
// subscribe(). It owns the connection, provides an offline solo fallback so the
// game still runs single-player when the party server is unreachable or nobody
// else is around, and exposes the host-authoritative verbs the scene uses.
// Poll `tick()` once per frame; read the getters each frame.
//
// Semantics mirror the package exactly: shared-state and player-state patches
// shallow-merge (last-write-wins per field), and events are fire-and-forget.
// Offline, everything loops back locally so the same code paths keep working.
//
// Keep this file byte-identical across games/*/src/net/session.ts — per-game
// tuning (room, maxPlayers, fallbackMs) goes in the NetSession constructor.
//

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient, ServerClock } from "@vibedgames/multiplayer";
import type {
  ClaimMap,
  InterestRule,
  Player,
  PlayerLimit,
  PlayerMap,
  SendEventOptions,
} from "@vibedgames/multiplayer";

import type { JsonObject, JsonValue } from "../json";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const SOLO_ID = "solo";

export interface NetSessionOptions {
  room: string;
  maxPlayers?: number;
  /** Give up on the party server after this long and fall back to solo. */
  fallbackMs: number;
  /** Start (and stay) in local solo mode — no socket is ever opened. Used by
   *  trailer mode, which must never show live players in a staged shot. */
  forceOffline?: boolean;
  /** The room's interest rule: players farther apart stop receiving each
   *  other's player state, and read `visible: false`. A room keeps the first
   *  client's rules, so every client passes the same. */
  interest?: InterestRule;
  /** Bounds the server holds numeric player-state keys to: a patch setting
   *  one outside its range is dropped before anyone sees it. A room rule. */
  limits?: Record<string, PlayerLimit>;
  onEvent?: (event: string, payload: JsonValue, from: string) => void;
  /** A claim's owner was set: granted, released (null), or — to a refused
   *  claimer alone — whoever already holds it. Online only. */
  onClaim?: (key: string, owner: string | null) => void;
}

export class NetSession {
  private client: MultiplayerClient | null;
  private readonly fallbackMs: number;
  private readonly onEvent?: (event: string, payload: JsonValue, from: string) => void;
  private readonly onClaim?: (key: string, owner: string | null) => void;

  private solo = false;
  private everConnected = false;
  private bootedAt = 0;
  private offlineMyState: JsonObject = {};
  private offlineShared: JsonObject | null = null;
  /** Offline there is no server to measure: a ServerClock never sampled reads the local clock. */
  private readonly localClock = new ServerClock();

  constructor(opts: NetSessionOptions) {
    this.fallbackMs = opts.fallbackMs;
    this.onEvent = opts.onEvent;
    this.onClaim = opts.onClaim;
    // Offline BY INTENT (`?offline=1`, trailer staging) is a different state
    // from the fallback below, and must skip constructing the client rather
    // than lean on a failed connection: a refused handshake logs a console
    // error the page cannot suppress, and the game would still be unplayable
    // until `fallbackMs` elapsed. Every `this.client` read below is null-safe.
    this.solo = opts.forceOffline === true || isOfflineRequested();
    this.client = this.solo
      ? null
      : new MultiplayerClient({
          host: MULTIPLAYER_HOST,
          interest: opts.interest,
          limits: opts.limits,
          maxPlayers: opts.maxPlayers,
          onClaim: (key, owner) => this.onClaim?.(key, owner),
          // SAFETY: event payloads are decoded JSON off the wire; the package
          // types them `unknown` only because it cannot know game schemas.
          onEvent: (event, payload, from) => this.onEvent?.(event, payload as JsonValue, from),
          party: "vg-server",
          room: opts.room,
        });
  }

  /** Call once per frame: drives the offline fallback timer. */
  tick(): void {
    const { client } = this;
    if (this.solo || !client) {
      return;
    }
    // Start the grace window on the FIRST tick, not at construction: heavy games
    // (lots of assets/wasm) can take longer than the window just to reach their
    // first frame, and counting that load time would wrongly drop a client to
    // solo before its socket ever got a chance to connect.
    if (this.bootedAt === 0) {
      this.bootedAt = performance.now();
    }
    const status = client.connectionStatus;
    if (status === "connected") {
      this.everConnected = true;
      return;
    }
    // Once we've been in a room, a drop is transient — let partysocket
    // reconnect instead of stranding the player in solo. (A reset under heavy
    // load must not permanently drop a real player out of the game.)
    if (this.everConnected) {
      return;
    }
    // Pre-connect errors/closes are NOT instant failures: partysocket retries
    // by itself, and a single refused handshake (cold server, wifi blip) must
    // not strand the player in solo for the whole session. The deadline is the
    // only fallback trigger.
    if (performance.now() - this.bootedAt < this.fallbackMs) {
      return;
    }
    // Never reached a room within the grace window: the party server is
    // unreachable — fall back to a local solo game.
    this.solo = true;
    // stop reconnect attempts; refresh the page to retry
    client.destroy();
  }

  get offline(): boolean {
    return this.solo;
  }

  /** Connected to a room, or running the solo fallback. */
  get live(): boolean {
    return this.solo || this.client?.connectionStatus === "connected";
  }

  get connectionStatus(): string {
    const { client } = this;
    return this.solo || !client ? "offline" : client.connectionStatus;
  }

  get isHost(): boolean {
    return this.solo || this.client?.isHost === true;
  }

  /** The current room host's id (for authenticating host-only events). */
  get hostId(): string | null {
    const { client } = this;
    return this.solo || !client ? SOLO_ID : client.hostId;
  }

  get playerId(): string | null {
    const { client } = this;
    return this.solo || !client ? SOLO_ID : client.playerId;
  }

  /** The room's shared clock (the local one offline) — what Interpolators render against. */
  get serverClock(): ServerClock {
    const { client } = this;
    return this.solo || !client ? this.localClock : client.serverClock;
  }

  /** Server time now (ms since the epoch): one instant for every player in the room. */
  serverNow(): number {
    return this.serverClock.now();
  }

  /** True once the server clock has been measured. Before that `serverNow()`
   *  reads the local clock, which means nothing to a peer — don't stamp with it. */
  get timeSynced(): boolean {
    const { client } = this;
    return !this.solo && client !== null && client.serverClock.synced;
  }

  get players(): PlayerMap {
    const { client } = this;
    return this.solo || !client
      ? { [SOLO_ID]: { id: SOLO_ID, state: this.offlineMyState } }
      : client.players;
  }

  /** The other player in the room, or null when alone. */
  otherPlayer(): Player | null {
    const me = this.playerId;
    for (const [id, p] of Object.entries(this.players)) {
      if (id !== me) {
        return p;
      }
    }
    return null;
  }

  get sharedState(): JsonObject | null {
    if (this.solo || !this.client) {
      return this.offlineShared;
    }
    const s = this.client.sharedState;
    if (!s || Object.keys(s).length === 0) {
      return null;
    }
    // SAFETY: shared state is decoded JSON off the wire; the package types it
    // `Record<string, unknown>` only because it cannot know game schemas.
    return s as JsonObject;
  }

  /** Per-player state shallow-merges, mirroring the package semantics. */
  updateMyState(patch: JsonObject): void {
    if (this.solo || !this.client) {
      Object.assign(this.offlineMyState, patch);
    } else {
      this.client.updateMyState(patch);
    }
  }

  /** Shared-state patch shallow-merges; host-only on the server. */
  patchShared(patch: JsonObject): void {
    if (this.solo || !this.client) {
      this.offlineShared = { ...this.offlineShared, ...patch };
    } else {
      this.client.updateSharedState(patch);
    }
  }

  /**
   * Events loop straight back to the local handler when offline. `to` /
   * `except` target player ids (server-enforced); offline, the local player
   * is the only id, so the loopback honours them against it.
   */
  sendEvent(event: string, payload: JsonObject, options?: SendEventOptions): void {
    const { client } = this;
    if (this.solo || !client) {
      const to = options?.to;
      const except = options?.except;
      const listed = (ids: string | string[] | undefined): boolean =>
        ids !== undefined && (Array.isArray(ids) ? ids.includes(SOLO_ID) : ids === SOLO_ID);
      if ((to === undefined || listed(to)) && !listed(except)) {
        this.onEvent?.(event, payload, SOLO_ID);
      }
      return;
    }
    client.sendEvent(event, payload, options);
  }

  /**
   * An intent only the host acts on. The host — and an offline game — handles
   * it locally and synchronously, like the offline loopback, instead of
   * bouncing it off the server; a guest sends it to the host alone.
   */
  sendToHost(event: string, payload: JsonObject): void {
    const { client } = this;
    if (this.solo || !client) {
      this.onEvent?.(event, payload, SOLO_ID);
      return;
    }
    if (client.isHost) {
      this.onEvent?.(event, payload, client.playerId ?? SOLO_ID);
      return;
    }
    const host = client.hostId;
    if (host !== null) {
      client.sendEvent(event, payload, { to: host });
    }
  }

  /** Ask the server for `key`: first come, first served, decided in one hop.
   *  Offline nothing arbitrates, and nothing is sent. */
  claim(key: string, options?: { ttlMs?: number }): void {
    if (!this.solo) {
      this.client?.claim(key, options);
    }
  }

  /** Give `key` back: its owner may, and the host may release any key. */
  release(key: string): void {
    if (!this.solo) {
      this.client?.release(key);
    }
  }

  /** Host only: release every key starting with `prefix`. */
  clearClaims(prefix: string): void {
    if (!this.solo) {
      this.client?.clearClaims(prefix);
    }
  }

  /** Who holds `key` now, or null (never claimed, released, lapsed — or offline). */
  ownerOf(key: string): string | null {
    const { client } = this;
    return this.solo || !client ? null : client.ownerOf(key);
  }

  /** Every claimed key the room holds (none offline). */
  get claims(): ClaimMap {
    const { client } = this;
    return this.solo || !client ? {} : client.claims;
  }

  destroy(): void {
    if (!this.solo) {
      this.client?.destroy();
    }
  }
}
