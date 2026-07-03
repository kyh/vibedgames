// Thin adapter over @vibedgames/multiplayer for the plain-loop (non-React,
// non-Phaser) games. It owns the connection, provides an offline solo fallback
// so the game still runs single-player when the party server is unreachable or
// nobody else is around, and exposes the host-authoritative verbs the scene
// uses. Poll `tick()` once per frame; read the getters each frame (the scene
// drives rendering from its own RAF loop, so there is no subscribe()).
//
// Semantics mirror the package exactly: shared-state and player-state patches
// shallow-merge (last-write-wins per field), and events are fire-and-forget.
// Offline, everything loops back locally so the same code paths keep working.

import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const SOLO_ID = "solo";

export type NetSessionOptions = {
  room: string;
  maxPlayers?: number;
  /** Give up on the party server after this long and fall back to solo. */
  fallbackMs: number;
  onEvent?: (event: string, payload: unknown, from: string) => void;
};

export class NetSession {
  private client: MultiplayerClient;
  private readonly fallbackMs: number;
  private readonly onEvent?: (event: string, payload: unknown, from: string) => void;

  private solo = false;
  private bootedAt = 0;
  private offlineMyState: Record<string, unknown> = {};
  private offlineShared: Record<string, unknown> | null = null;

  constructor(opts: NetSessionOptions) {
    this.fallbackMs = opts.fallbackMs;
    this.onEvent = opts.onEvent;
    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: "vg-server",
      room: opts.room,
      maxPlayers: opts.maxPlayers,
      onEvent: (event, payload, from) => this.onEvent?.(event, payload, from),
    });
    this.bootedAt = performance.now();
  }

  /** Call once per frame: drives the offline fallback timer. */
  tick(): void {
    if (this.solo) return;
    const status = this.client.connectionStatus;
    const failed = status === "disconnected" || status === "error";
    if (!failed && performance.now() - this.bootedAt < this.fallbackMs) return;
    if (!failed && status === "connected") return;
    // Never connected within the grace window (or the socket errored): go solo.
    this.solo = true;
    this.client.destroy(); // stop reconnect attempts; refresh the page to retry
  }

  get offline(): boolean {
    return this.solo;
  }

  /** Connected to a room, or running the solo fallback. */
  get live(): boolean {
    return this.solo || this.client.connectionStatus === "connected";
  }

  get connectionStatus(): string {
    return this.solo ? "offline" : this.client.connectionStatus;
  }

  get isHost(): boolean {
    return this.solo || this.client.isHost;
  }

  get playerId(): string | null {
    return this.solo ? SOLO_ID : this.client.playerId;
  }

  get players(): PlayerMap {
    return this.solo ? { [SOLO_ID]: { id: SOLO_ID, state: this.offlineMyState } } : this.client.players;
  }

  /** The other player in the room, or null when alone. */
  otherPlayer(): Player | null {
    const me = this.playerId;
    for (const [id, p] of Object.entries(this.players)) {
      if (id !== me) return p;
    }
    return null;
  }

  get sharedState(): Record<string, unknown> | null {
    if (this.solo) return this.offlineShared;
    const s = this.client.sharedState;
    return s && Object.keys(s).length > 0 ? s : null;
  }

  /** Per-player state shallow-merges, mirroring the package semantics. */
  updateMyState(patch: Record<string, unknown>): void {
    if (this.solo) Object.assign(this.offlineMyState, patch);
    else this.client.updateMyState(patch);
  }

  /** Shared-state patch shallow-merges; host-only on the server. */
  patchShared(patch: Record<string, unknown>): void {
    if (this.solo) {
      this.offlineShared = { ...this.offlineShared, ...patch };
    } else {
      this.client.updateSharedState(patch);
    }
  }

  /** Events loop straight back to the local handler when offline. */
  sendEvent(event: string, payload: Record<string, unknown>): void {
    if (this.solo) this.onEvent?.(event, payload, SOLO_ID);
    else this.client.sendEvent(event, payload);
  }

  destroy(): void {
    if (!this.solo) this.client.destroy();
  }
}
