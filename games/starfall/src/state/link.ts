import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonRecord, PlayerMap } from "@vibedgames/multiplayer";
import type { WireRecord, WireValue } from "../net/wire-read";
import { now as simNow } from "../shared/clock";
import { INTEREST_RADIUS, OFFLINE_FALLBACK_MS } from "../shared/constants";
import type { PlayerNetState } from "../shared/constants";
import type { TrailerStaging } from "../trailer/trailer-staging";

interface LinkOptions {
  /** Inbound event sink: the room's events, and the host's own intents,
   *  which the SDK hands straight over (offline, this client hosts). */
  inbox: (event: string, payload: WireValue, from: string) => void;
  /** A claim's owner, as the server settled it: granted (everyone hears it),
   *  the holder (a refused claimer alone hears it) or released (null).
   *  Offline the SDK grants every claim at once and releases it on its TTL. */
  onClaim?: (key: string, owner: string | null) => void;
}

interface ConnectOptions {
  host: string;
  maxPlayers: number;
  /** Offline by intent (?offline=1, a playtest, the trailer): never dial. */
  offline: boolean;
  onUpdate: () => void;
  /** Back in the room after a drop (reconnecting → connected): every
   *  sender's route to this client is new. Seen in the subscribe listener,
   *  so a drop and its reconnect inside a hidden tab are not missed. */
  onReadmitted?: () => void;
  room: string;
}

/**
 * Session identity and the SDK client behind it: who I am, who is here,
 * whether the arena is live, and which sends wait for the link. Offline, the
 * client is a local room of one with the same API, so a solo arena runs the
 * online code paths: this client hosts, my intents and claims come straight
 * back, and nothing is sent. The SDK client is wrapped, never handed out,
 * except to the DEV harness.
 */
export class Link {
  /** True only after this connected host has adopted the accepted room world. */
  hostSnapshotReady = false;
  /** Each peer's net state for this frame, filled by the PeerRoster: parsed
   *  once per patch, a remote's pose interpolated. Null for me, for peers
   *  mid-drop and for peers out of interest range. */
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
  private readonly claimSink: LinkOptions["onClaim"];

  constructor(options: LinkOptions) {
    this.inbox = options.inbox;
    this.claimSink = options.onClaim;
  }

  /** Dial the party server, or with `offline` open a room of one that never
   *  does. No `initialState`: the package re-applies it whenever a client
   *  becomes host, which would wipe the live world on host migration — the
   *  first host seeds explicitly (WorldSync.ensureSeeded).
   *  Interest: a player out of range reads `visible: false` and its state
   *  stops updating (PeerRoster hides it); the host still sees everyone.
   *  Fallback: if no room admits this client within OFFLINE_FALLBACK_MS of
   *  rendered frames, the SDK goes offline and the scene seeds a solo arena.
   *  Until then a refused handshake (cold server, wifi blip) is only
   *  retried; once admitted, a drop reconnects and never falls back. */
  connect(options: ConnectOptions): void {
    const client = new MultiplayerClient({
      fallbackMs: OFFLINE_FALLBACK_MS,
      host: options.host,
      interest: { radius: INTEREST_RADIUS },
      maxPlayers: options.maxPlayers,
      offline: options.offline,
      onClaim: (key, owner) => this.claimSink?.(key, owner),
      onEvent: (event, payload, from) => this.inbox(event, payload, from),
      party: "vg-server",
      room: options.room,
    });
    this.client = client;
    let status = client.connectionStatus;
    client.subscribe(() => {
      const was = status;
      status = client.connectionStatus;
      if (was === "reconnecting" && status === "connected") {
        options.onReadmitted?.();
      }
      options.onUpdate();
    });
  }

  /** Leave the room for a solo arena (refresh to go online again). */
  goOffline(): void {
    this.client?.goOffline();
  }

  destroy(): void {
    this.client?.destroy();
  }

  /** A local room of one: by intent, after the fallback, or goOffline. */
  get offline(): boolean {
    return this.client?.connectionStatus === "offline";
  }

  /** Server time is known: a clock probe has answered, or this client is
   *  offline, where the local clock is the room's. Stamps are taken in it. */
  private get clockSynced(): boolean {
    return this.client?.serverClock.synced === true;
  }

  /** In the room with its clock measured. Everything on the wire is stamped
   *  with server time, so nothing goes out — and no snapshot is read — before
   *  the first clock probe answers, about one round trip after admission. */
  get connected(): boolean {
    return this.client?.connectionStatus === "connected" && this.clockSynced;
  }

  /** Server time at local `performance.now()` time `localNow`: the room's
   *  shared clock, so a stamp means the same instant to every client, whoever
   *  hosts. Offline, where nothing is stamped, the local clock. */
  serverNow(localNow: number = performance.now()): number {
    return this.client?.serverNow(localNow) ?? localNow;
  }

  /** Server time at the sim-clock instant `simT` (shared/clock.ts): online
   *  the sim clock never pauses, so the two tick together. */
  serverAt(simT: number): number {
    return this.serverNow() + (simT - simNow());
  }

  /** In the arena — connected, or reconnecting after a drop — or offline. A
   *  drop keeps the local world ticking on prediction (nobody stares at a
   *  frozen arena); readmission reconciles it. Admitted but still waiting on
   *  the first clock probe is not live yet: nothing is stamped or read
   *  before the room clock is measured. */
  get live(): boolean {
    return this.clockSynced && this.client?.connectionStatus !== "connecting";
  }

  /** The SDK keeps hostId across a drop, so a host rides through its own blip
   *  as host: the world it authored stays authoritative, and on readmission
   *  the SDK re-sends whatever of it the server holds differently instead of
   *  rewinding to the server's last snapshot. If the server migrated host
   *  meanwhile, `sync` flips isHost and prepareHost demotes us — a former
   *  host never re-adopts its own stale snapshot. */
  get amHost(): boolean {
    return this.live && this.client?.isHost === true;
  }

  get myId(): string | null {
    return this.client?.playerId ?? null;
  }

  /** Offline the SDK's room of one holds just my own entry, so every
   *  `id === myId` render path (ship gfx, shield ring, impact arcs, twin
   *  drone, windup glow, nitro trail, minimap own-dot) runs solo as online.
   *  Trailer scenes swap in a fake peer map (staged local "remotes"). */
  get peers(): PlayerMap {
    return this.trailer?.peers ?? this.client?.players ?? {};
  }

  /** The room's shared snapshot as the SDK holds it (null before connect).
   *  Identity changes exactly when a real state patch lands. */
  get sharedState(): JsonRecord | null {
    return this.client?.sharedState ?? null;
  }

  /** Raw SDK client for the DEV harness only (`__starfall.client`). */
  get rawClient(): MultiplayerClient | null {
    return this.client;
  }

  /** An intent for the host alone. The host — offline too — has the SDK hand
   *  it to the inbox right here, with no round trip through the server. A
   *  guest sends nothing while dropped: the socket would queue a batch every
   *  frame and replay the backlog on reconnect, against a world gone by. */
  toHost(event: string, payload: WireRecord): void {
    if (this.amHost || this.connected) {
      this.client?.sendToHost(event, payload);
    }
  }

  /** Something that happened to me, for everyone else (shots, deaths). Not
   *  sent while dropped (see `toHost`): a shot is only news when it's fired. */
  broadcast(event: string, payload: WireRecord): void {
    const me = this.client?.playerId;
    if (me && this.connected) {
      this.client?.sendEvent(event, payload, { except: me });
    }
  }

  /** An event for one player. Not sent while dropped (see `toHost`). */
  sendTo(id: string, event: string, payload: WireRecord): void {
    if (this.connected) {
      this.client?.sendEvent(event, payload, { to: id });
    }
  }

  /** Host → room: shallow-merge patch of the shared world. While the link is
   *  down the SDK keeps the patch and sends nothing; readmitted as host, it
   *  re-sends every key the server holds differently, so guests catch up on
   *  whatever changed in the drop. */
  patchShared(patch: WireRecord): void {
    this.client?.updateSharedState(patch);
  }

  /** Claims can be made: online and connected, or offline. While the link is
   *  down a claim would wait in the socket past its pickup's pending window
   *  (sys/pickups.ts), so nothing is claimed until it is back. */
  get canClaim(): boolean {
    return this.offline || this.connected;
  }

  /** Ask for `key` — first come, first served, settled by the server in one
   *  hop for every client alike, the host included; `onClaim` hears the
   *  answer. It lapses after `ttlMs`. Offline nobody contends: the SDK grants
   *  it before this returns. Only while `canClaim`. */
  claim(key: string, ttlMs: number): void {
    this.client?.claim(key, { ttlMs: Math.max(1, Math.round(ttlMs)) });
  }

  /** Someone holds `key` (offline that is me, until the claim lapses). */
  claimed(key: string): boolean {
    return (this.client?.ownerOf(key) ?? null) !== null;
  }

  /** My state push (flat primitives; unchanged keys stay off the wire). It is
   *  stamped with server time, so it waits for the clock; while the link is
   *  down the SDK keeps the latest and sends it on readmission. */
  pushMyState(state: WireRecord): void {
    if (this.clockSynced) {
      this.client?.updateMyState(state);
    }
  }
}
