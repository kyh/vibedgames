import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";
import type { WireRecord, WireValue } from "../net/wire-read";
import { OFFLINE_FALLBACK_MS } from "../shared/constants";
import type { PlayerNetState } from "../shared/constants";
import type { TrailerStaging } from "../trailer/trailer-staging";

type SharedPatch = Parameters<MultiplayerClient["updateSharedState"]>[0];
type SharedSnapshot = MultiplayerClient["sharedState"];

/** Offline stand-in for `client.players`: the synthesized self entry (see the
 *  `peers` getter). Read-only in practice, so one shared object is safe. */
const SOLO_PEERS: PlayerMap = { solo: { id: "solo" } };

interface LinkOptions {
  /** Inbound event sink — also where offline sends loop straight back to. */
  inbox: (event: string, payload: WireValue, from: string) => void;
}

interface ConnectOptions {
  host: string;
  maxPlayers: number;
  onUpdate: () => void;
  room: string;
}

/** What `poll()` observed this tick. */
export type LinkStep =
  /** Nothing for the scene to do. */
  | "steady"
  /** Reconnected as the continuing host: patches sent into the drop were
   *  discarded, so the next share must carry the whole world. */
  | "readmitted-host"
  /** Never reached the arena inside the grace window: dropped to solo. */
  | "fallback";

/**
 * Session identity and the socket behind it: who I am, who is here, whether
 * the arena is live, and the solo fallback that turns this client into its
 * own host over the same code paths (events loop back, network writes no-op).
 * The SDK client is wrapped, never handed out, except to the DEV harness.
 */
export class Link {
  /** Solo fallback / explicit ?offline=1 / trailer: no socket, local world is
   *  authoritative. */
  offline = false;
  /** True only after this connected host has adopted the accepted room world. */
  hostSnapshotReady = false;
  /** Each peer's net state, parsed ONCE per frame — identity only changes on
   *  a ~20Hz patch, and the hot paths read it many times. */
  readonly peerStates = new Map<string, PlayerNetState | null>();
  /** False until the player dismisses the start screen. Gates spawning so the
   *  ship isn't dropped into a live arena while the controls are still up. */
  started = false;
  /** Paused-as-spectator: the wrapper asked for its chrome back, so my ship is
   *  cleanly docked out of the arena (no death penalty). Gates spawn/respawn so
   *  the ship isn't re-dropped, and my net state advertises absence (present:
   *  false) so remotes silently drop me with no death FX. */
  paused = false;
  /** Offline-only REAL freeze (sim clock stopped, render loop asleep). */
  frozen = false;
  /** Trailer-mode staging overrides (src/trailer/). Null outside ?trailer=1,
   *  so every trailer guard is dead code in normal play. A trailer session is
   *  always offline, and its staged fake peers are what `peers` serves. */
  trailer: TrailerStaging | null = null;

  private client: MultiplayerClient | null = null;
  private readonly inbox: LinkOptions["inbox"];
  /** Stamped on the FIRST poll (not create()): heavy boots must not eat into
   *  the grace window before the socket gets a chance to connect. */
  private bootedAt = 0;
  /** True once we've ever reached a room — after that, drops reconnect. */
  private everConnected = false;
  /** Last tick's connection state, for the readmission edge. */
  private linkUp = false;

  constructor(options: LinkOptions) {
    this.inbox = options.inbox;
  }

  /** Dial the party server. No `initialState`: the package re-applies it
   *  whenever a client becomes host, which would wipe the live world on host
   *  migration — the first host seeds explicitly (WorldSync.ensureSeeded). */
  connect(options: ConnectOptions): void {
    this.client = new MultiplayerClient({
      host: options.host,
      maxPlayers: options.maxPlayers,
      onEvent: (event, payload, from) => this.inbox(event, payload, from),
      party: "vg-server",
      room: options.room,
    });
    this.client.subscribe(options.onUpdate);
  }

  /** Become own host: stop reconnect attempts (refresh to go online). */
  goOffline(): void {
    this.offline = true;
    this.client?.destroy();
  }

  destroy(): void {
    // offline already destroyed it
    if (!this.offline) {
      this.client?.destroy();
    }
  }

  get connected(): boolean {
    return this.client?.connectionStatus === "connected";
  }

  /** In the arena — connected, or reconnecting after a drop — or running the
   *  solo offline fallback. A drop keeps the local world ticking on prediction
   *  (nobody stares at a frozen arena); readmission reconciles it. */
  get live(): boolean {
    return this.offline || this.connected || this.everConnected;
  }

  /** The SDK keeps hostId across a drop, so a host rides through its own blip
   *  as host: the world it authored stays authoritative and resumes streaming
   *  on readmission instead of rewinding to the server's last snapshot. If the
   *  server migrated host meanwhile, `sync` flips isHost and prepareHost
   *  demotes us — a former host never re-adopts its own stale snapshot. */
  get amHost(): boolean {
    return this.offline || (this.live && this.client?.isHost === true);
  }

  get myId(): string | null {
    return this.offline ? "solo" : (this.client?.playerId ?? null);
  }

  get peers(): PlayerMap {
    // Offline: synthesize the self entry so every `id === myId` render path
    // (ship gfx, shield ring, impact arcs, twin drone, windup glow, nitro
    // trail, minimap own-dot) still runs solo. cssToInt(undefined) → white.
    // Trailer scenes may swap in a fake peer map (staged local "remotes").
    if (this.offline) {
      return this.trailer?.peers ?? SOLO_PEERS;
    }
    return this.client?.players ?? {};
  }

  /** The room's shared snapshot as the SDK holds it (null with no socket).
   *  Identity changes exactly when a real state patch lands. */
  get sharedState(): SharedSnapshot | null {
    return this.client?.sharedState ?? null;
  }

  /** Raw SDK client for the DEV harness only (`__starfall.client`). */
  get rawClient(): MultiplayerClient | null {
    return this.client;
  }

  /** Events loop straight back into the local host when offline. Nothing is
   *  sent while dropped: the socket would queue every message unbounded and
   *  replay the backlog on reconnect. */
  send(event: string, payload: WireRecord): void {
    if (this.offline) {
      this.inbox(event, payload, "solo");
    } else if (this.client && this.connected) {
      this.client.sendEvent(event, payload);
    }
  }

  /** Host → room: shallow-merge patch of the shared world. Dropped while
   *  disconnected for the same reason as `send`. */
  patchShared(patch: SharedPatch): void {
    if (!this.offline && this.client && this.connected) {
      this.client.updateSharedState(patch);
    }
  }

  /** My 20Hz player-state push. */
  pushMyState(state: SharedPatch): void {
    if (!this.offline && this.client && this.connected) {
      this.client.updateMyState(state);
    }
  }

  /** One connection-state step per frame while online. Gives up on the party
   *  server after the grace window (→ "fallback": the caller seeds the solo
   *  world); once we've ever been in the arena a drop is transient and the
   *  socket reconnects by itself. */
  poll(): LinkStep {
    // Real wall clock, NOT the pausable sim clock — connection deadlines must
    // keep counting through a pause (same contract as the clock module doc).
    if (this.bootedAt === 0) {
      this.bootedAt = Date.now();
    }
    if (this.connected) {
      const readmitted = this.everConnected && !this.linkUp && this.hostSnapshotReady;
      this.linkUp = true;
      this.everConnected = true;
      return readmitted ? "readmitted-host" : "steady";
    }
    this.linkUp = false;
    // Once we've been in the arena, a drop is transient — let the socket
    // reconnect instead of stranding a real player in a solo world.
    if (this.everConnected) {
      return "steady";
    }
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, and a single refused handshake (cold server, wifi blip) must
    // not force a whole solo session. The deadline is the only trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) {
      return "steady";
    }
    this.goOffline();
    return "fallback";
  }
}
