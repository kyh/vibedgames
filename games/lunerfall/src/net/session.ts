// Lunerfall's party room, over @vibedgames/multiplayer, for a scene that polls
// from its own frame loop instead of subscribing: read the getters each frame.
// The client is the whole connection. It plays offline by intent (`?offline=1`)
// without ever dialing, and goes offline by itself when no room admits it
// within `fallbackMs`: either way it is a local room of one with the same API,
// this player hosting as OFFLINE_PLAYER_ID, so solo runs the online code path.
//
// What this adds is lunerfall's own:
// - An invite code names one room, so an overflow redirect is refused and
//   reported as `roomFull` rather than followed into a parallel expedition.
// - Every admission change (status, player id, host) bumps `authorityRevision`,
//   and every drop `disconnectRevision`: the scene keys its exact checkpoint
//   handoff on them.
// - Every shared-state change reaches `onShared` as it lands: a guest polling
//   once per frame would miss a snapshot that arrived bunched with the next
//   one, and the interpolation would lose its timestamp.
// - The host role and the input uplink only count from inside a room.

import { isOfflineRequested } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { MultiplayerConnectionStatus, Player, PlayerMap } from "@vibedgames/multiplayer";

import type { JsonValue } from "./json";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

// How the page booted, read before the hub rewrites the URL to a room link
// (party and mode only): a page booted `?offline=1` never dials, hub or not.
const OFFLINE_BY_INTENT = isOfflineRequested();

export interface NetSessionOptions {
  room: string;
  maxPlayers?: number;
  /** Play on offline when no room has admitted this client within this long
   *  (ms of rendered frames, from the first one after construction). */
  fallbackMs: number;
  onEvent?: (event: string, payload: JsonValue, from: string) => void;
  /** Every new shared state, in arrival order. */
  onShared?: (state: Record<string, JsonValue>) => void;
}

export class NetSession {
  private readonly client: MultiplayerClient;
  private readonly onShared?: (state: Record<string, JsonValue>) => void;
  private seenShared: Record<string, JsonValue> | null = null;

  private admissionRevision = 0;
  private droppedRevision = 0;
  private unwatch: (() => void) | null = null;
  private full = false;

  constructor(opts: NetSessionOptions) {
    this.onShared = opts.onShared;
    const client = new MultiplayerClient({
      fallbackMs: opts.fallbackMs,
      host: MULTIPLAYER_HOST,
      maxPlayers: opts.maxPlayers,
      // Never dials: no socket, and no handshake error the page cannot
      // suppress.
      offline: OFFLINE_BY_INTENT,
      onEvent: opts.onEvent,
      party: "vg-server",
      room: opts.room,
    });
    this.client = client;
    let { connectionStatus: status, hostId, playerId } = client;
    this.unwatch = client.subscribe(() => {
      // An invite identifies one room; the SDK's matchmaking overflow must
      // not admit this player into a different expedition under that code.
      if (client.room !== opts.room) {
        this.full = true;
        this.destroy();
        return;
      }
      const shared = client.sharedState;
      if (shared !== this.seenShared) {
        this.seenShared = shared;
        this.onShared?.(shared);
      }
      if (
        status === client.connectionStatus &&
        playerId === client.playerId &&
        hostId === client.hostId
      ) {
        return;
      }
      // Out of the room it was in: the transport dropped ("reconnecting").
      if (status === "connected" && client.connectionStatus !== "connected") {
        this.droppedRevision += 1;
      }
      ({ connectionStatus: status, hostId, playerId } = client);
      this.admissionRevision += 1;
    });
  }

  /** Bumps on every status/player/host change, even ones that flip back
   * between two scene frames — the scene keys its checkpoint adoption on it. */
  get authorityRevision(): number {
    return this.admissionRevision;
  }

  /** Bumps each time the room drops this client. */
  get disconnectRevision(): number {
    return this.droppedRevision;
  }

  get roomFull(): boolean {
    return this.full;
  }

  get connectionStatus(): MultiplayerConnectionStatus {
    return this.client.connectionStatus;
  }

  /** A local room of one: offline by intent, or no room answered in time. */
  get offline(): boolean {
    return this.client.connectionStatus === "offline";
  }

  /** In a room: admitted to the party room, or playing offline. */
  get live(): boolean {
    const status = this.client.connectionStatus;
    return status === "connected" || status === "offline";
  }

  /**
   * The room's authority, from inside the room only. While its transport is
   * down a host keeps reading itself as host, but the server hands the role to
   * the other player once the drop outlasts the host's liveness window: until
   * the room readmits it, this client is nobody's host.
   */
  get isHost(): boolean {
    return this.live && this.client.isHost;
  }

  /**
   * The room's server time (ms since the epoch) at `localNow` (performance.now
   * ms; default now), measured by the SDK: one timebase for every client in
   * the room, so a stamp means the same moment to the guest that the host
   * meant, whichever client is host.
   */
  serverNow(localNow?: number): number {
    return this.client.serverNow(localNow);
  }

  get playerId(): string | null {
    return this.client.playerId;
  }

  get players(): PlayerMap {
    return this.client.players;
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

  get sharedState(): Record<string, JsonValue> {
    return this.client.sharedState;
  }

  /** Per-player state shallow-merges. Before admission there is no player to
   *  write; while reconnecting the client keeps the latest for the room. */
  updateMyState(patch: Record<string, JsonValue>): void {
    this.client.updateMyState(patch);
  }

  /** Shared-state patch shallow-merges; the host's alone. */
  patchShared(patch: Record<string, JsonValue>): void {
    if (this.isHost) {
      this.client.updateSharedState(patch);
    }
  }

  /**
   * An intent only the host acts on: the host (an offline game too) handles
   * it synchronously, a guest sends it to the host alone. Only from inside a
   * room — events queue across a drop, and stale input ticks must not replay
   * on reconnect.
   */
  sendToHost(event: string, payload: Record<string, JsonValue>): void {
    if (this.live) {
      this.client.sendToHost(event, payload);
    }
  }

  destroy(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.client.destroy();
  }
}
