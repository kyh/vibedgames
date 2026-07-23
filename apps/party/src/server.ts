import type { Connection, ConnectionContext } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type { ClientMessage, Player, PlayerMap, ServerMessage } from "@vibedgames/multiplayer";
import {
  EVICTION_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  ROOM_CAP_QUERY_PARAM,
} from "@vibedgames/multiplayer";
import { getColorById } from "./color";

type Env = {
  VgServer: DurableObjectNamespace<VgServer>;
  DB: D1Database;
};

/**
 * Durable presence: identity plus the two liveness clocks, kept in the
 * connection's attachment so it survives Cloudflare's WebSocket hibernation
 * (which evicts the Durable Object instance but keeps the sockets). Tiny and
 * bounded — deliberately NOT the per-frame game state, which would risk the 2KB
 * attachment cap and cost a serialize every tick.
 *
 * - `aliveAt`: last time we heard *anything* on the keepalive channel (heartbeat
 *   or pong) — drives eviction. A hidden tab still pongs, so backgrounding never
 *   removes a player.
 * - `seenAt`: last time we heard a *non-pong* keepalive (heartbeat) — drives
 *   host-liveness migration. A hidden tab's rAF heartbeat pauses while it still
 *   pongs, so a backgrounded host loses the host role but keeps its seat.
 */
type Presence = { id: string; color: string; hue: string; seenAt: number; aliveAt: number };

/** Durable, low-frequency room fields, persisted so they survive hibernation. */
const HOST_ID_KEY = "hostId";
const CAP_KEY = "cap";

/**
 * Upper bound on a single room's player cap, regardless of what a client
 * requests via the query param. Games are untrusted code, so we never let a
 * client size a room past this ceiling.
 */
const HARD_ROOM_CAP = 64;

/** Separator for overflow sibling rooms: `home` → `home~2` → `home~3`. */
const OVERFLOW_SEP = "~";

/**
 * Given a room id, return the next overflow sibling. Picks an unusual
 * separator so a normal slug like `level-1` is never mistaken for an
 * overflow room (which would alias two distinct games onto one room).
 */
const nextOverflowRoom = (room: string): string => {
  const idx = room.lastIndexOf(OVERFLOW_SEP);
  if (idx !== -1) {
    const suffix = room.slice(idx + OVERFLOW_SEP.length);
    if (/^\d+$/.test(suffix)) {
      return `${room.slice(0, idx)}${OVERFLOW_SEP}${Number(suffix) + 1}`;
    }
  }
  return `${room}${OVERFLOW_SEP}2`;
};

/** Read the client-requested player cap, clamped to the hard ceiling. */
const readRoomCap = (ctx: ConnectionContext): number | null => {
  const raw = new URL(ctx.request.url).searchParams.get(ROOM_CAP_QUERY_PARAM);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, HARD_ROOM_CAP);
};

export class VgServer extends Server {
  /**
   * Room state is split by how it must behave under Cloudflare's WebSocket
   * Hibernation API, which partyserver uses: an idle Durable Object is evicted
   * and its instance destroyed, but the open sockets — and their attachments —
   * survive. The split also mirrors how game netcode separates a high-frequency,
   * drop-tolerant snapshot channel from low-frequency reliable bookkeeping.
   *
   * - PRESENCE (identity + liveness) lives on each connection's attachment (see
   *   `Presence`), NOT an instance map. A parallel map was emptied on every
   *   hibernation, after which `onMessage` dropped every surviving connection's
   *   messages (they were no longer "admitted"), freezing those players into
   *   ghosts. Deriving presence from the live sockets makes that unrepresentable.
   * - SNAPSHOT (per-player game state + shared state) is the hot channel: kept in
   *   memory, broadcast every tick, never persisted. It self-heals — clients
   *   re-send on reconnect, the host re-streams shared state within a tick, and
   *   the room only hibernates when idle (nobody streaming). Persisting it would
   *   be pure write amplification and risk the 2KB attachment cap.
   * - SESSION (`hostId`, `cap`) changes rarely but MUST persist: a wiped host
   *   makes the real host's `state_patch` get rejected as non-host after a wake;
   *   a wiped cap lets a post-wake join exceed it. Mirrored in memory, written
   *   through to storage, rehydrated in `onStart()`.
   */
  private shared: Record<string, unknown> = {};
  private snapshots = new Map<string, Record<string, unknown>>();
  private hostId: string | null = null;
  private cap: number | null = null;

  /** Rehydrate durable session fields before any handler runs (partyserver awaits this). */
  async onStart() {
    this.hostId = (await this.ctx.storage.get<string | null>(HOST_ID_KEY)) ?? null;
    this.cap = (await this.ctx.storage.get<number | null>(CAP_KEY)) ?? null;
  }

  private async setHostId(id: string | null): Promise<void> {
    this.hostId = id;
    await this.ctx.storage.put(HOST_ID_KEY, id);
  }

  private async setCap(cap: number | null): Promise<void> {
    this.cap = cap;
    await this.ctx.storage.put(CAP_KEY, cap);
  }

  private toPlayer(presence: Presence): Player {
    return {
      id: presence.id,
      color: presence.color,
      hue: presence.hue,
      state: this.snapshots.get(presence.id) ?? {},
    };
  }

  /** The presence for a connection id, or undefined if not admitted. */
  private presenceOf(id: string): Presence | undefined {
    const connection = this.getConnection<Presence>(id);
    return connection?.state ?? undefined;
  }

  /** Public player map (identity from the attachment, state from the snapshot). */
  private players(): PlayerMap {
    const players: PlayerMap = {};
    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      if (presence) players[connection.id] = this.toPlayer(presence);
    }
    return players;
  }

  /** Count of admitted players (connections carrying presence), optionally minus one. */
  private playerCount(excludeId?: string): number {
    let count = 0;
    for (const connection of this.getConnections<Presence>()) {
      if (connection.id === excludeId) continue;
      if (connection.state) count++;
    }
    return count;
  }

  /**
   * Mark a connection heard-from on the keepalive channel. `seen` is true for a
   * non-pong keepalive (heartbeat) — the signal a backgrounded tab stops sending.
   */
  private touch(connection: Connection<Presence>, seen: boolean) {
    const presence = connection.state;
    if (!presence) return;
    const now = Date.now();
    connection.setState({ ...presence, aliveAt: now, seenAt: seen ? now : presence.seenAt });
  }

  /** Migrate host off a connection we haven't heard from within the liveness
   *  window (it vanished without a clean close). Picks the lowest-id live peer
   *  for determinism. No-op while the host is responsive or no live peer exists. */
  private async checkHostLiveness(): Promise<void> {
    const host = this.hostId;
    if (!host) return;
    const now = Date.now();
    const hostPresence = this.presenceOf(host);
    if (hostPresence && now - hostPresence.seenAt <= HOST_LIVENESS_TIMEOUT_MS) return;

    let next: Connection<Presence> | null = null;
    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      if (!presence || connection.id === host) continue;
      if (now - presence.seenAt > HOST_LIVENESS_TIMEOUT_MS) continue;
      if (!next || connection.id < next.id) next = connection;
    }
    if (!next) return; // nobody healthier to hand off to — keep the current host

    // Grace on the new host so we don't immediately re-migrate.
    const presence = next.state;
    if (presence) next.setState({ ...presence, seenAt: now });
    await this.setHostId(next.id);
    const hostMessage: ServerMessage = { type: "host", data: { id: next.id } };
    this.broadcast(JSON.stringify(hostMessage), []);
  }

  async onConnect(connection: Connection<Presence>, ctx: ConnectionContext) {
    // The room's effective cap for this admission decision: the sticky cap an
    // earlier admitted client established, or — if none yet — the cap this
    // client advertises. We don't persist the requested cap until we've
    // decided to admit (below), so a refused over-cap join can't retroactively
    // cap a room that never accepted it — which would otherwise also bounce
    // later, even uncapped, joins to overflow.
    const requestedCap = readRoomCap(ctx);
    const cap = this.cap ?? requestedCap;

    // Enforce the room cap before admitting the player. If full, point the
    // client at the overflow sibling and close — the SDK reconnects there.
    if (cap !== null && this.playerCount(connection.id) >= cap) {
      const fullMessage: ServerMessage = {
        type: "room_full",
        data: { room: nextOverflowRoom(this.name), capacity: cap },
      };
      connection.send(JSON.stringify(fullMessage));
      connection.close(4001, "room_full");
      return;
    }

    // Admitted: establish the room's cap stickily from the first admitted
    // client that advertises one, so a later join that omits `_maxPlayers` (a
    // rogue or stale client) can't bypass the cap legit clients set.
    if (this.cap === null && requestedCap !== null) {
      await this.setCap(requestedCap);
    }

    const now = Date.now();
    const { color, hue } = getColorById(connection.id);
    const presence: Presence = {
      id: connection.id,
      color,
      hue,
      seenAt: now,
      aliveAt: now,
    };
    connection.setState(presence);
    this.snapshots.set(connection.id, {});
    void this.scheduleSweep();
    if (!this.hostId) {
      await this.setHostId(connection.id);
    }
    // a fresh join is a good moment to evict a host that vanished while the room
    // was idle — so the newcomer lands in a live game, not a frozen one
    await this.checkHostLiveness();

    const syncMessage: ServerMessage = {
      type: "sync",
      data: {
        players: this.players(),
        state: this.shared,
        hostId: this.hostId ?? connection.id,
      },
    };
    connection.send(JSON.stringify(syncMessage));

    const joinedMessage: ServerMessage = {
      type: "player_joined",
      data: this.toPlayer(presence),
    };
    this.broadcast(JSON.stringify(joinedMessage), [connection.id]);
  }

  async onMessage(sender: Connection<Presence>, rawMessage: string): Promise<void> {
    try {
      // Admission gate: presence lives in the attachment, so a connection that
      // survived hibernation is still admitted even though its in-memory
      // snapshot was wiped — the next patch just re-fills it. A capacity-refused
      // connection carries no presence, so it cannot broadcast into the room.
      const presence = sender.state;
      if (!presence) return;

      const message = JSON.parse(rawMessage) as ClientMessage;

      switch (message.type) {
        case "player_state_patch": {
          // Hot path: snapshot + broadcast only. Liveness rides the heartbeat/
          // pong keepalive channel, so a per-tick stream costs no attachment write.
          const next = { ...(this.snapshots.get(sender.id) ?? {}), ...message.data };
          this.snapshots.set(sender.id, next);
          const updateMessage: ServerMessage = {
            type: "player_state",
            data: { id: sender.id, state: next },
          };
          this.broadcast(JSON.stringify(updateMessage), [sender.id]);
          break;
        }
        case "state_patch": {
          // Shared state is host-authoritative: only the elected host can write.
          // Non-host writes get a `state` echo back so the client can rewind its
          // local mirror, and we drop the patch instead of relaying. Also a hot
          // path (host streams ~30×/s), so no attachment write here either.
          if (sender.id !== this.hostId) {
            const echo: ServerMessage = {
              type: "state_patch",
              data: this.shared,
            };
            sender.send(JSON.stringify(echo));
            break;
          }
          this.shared = {
            ...this.shared,
            ...message.data,
          };
          const broadcastMessage: ServerMessage = {
            type: "state_patch",
            data: message.data,
          };
          this.broadcast(JSON.stringify(broadcastMessage), []);
          break;
        }
        case "heartbeat":
          // The keepalive that pauses when a tab is hidden — refreshes both
          // clocks and is the cadence we re-check host liveness on.
          this.touch(sender, true);
          await this.checkHostLiveness();
          break;
        case "pong":
          // Answers a server ping even from a hidden tab: proves reachable
          // (aliveAt) but not running (seenAt untouched).
          this.touch(sender, false);
          break;
        case "emit": {
          this.touch(sender, true);
          const eventMessage: ServerMessage = {
            type: "event",
            data: {
              event: message.data.event,
              payload: message.data.payload,
              from: sender.id,
            },
          };
          this.broadcast(JSON.stringify(eventMessage), []);
          break;
        }
        default:
          this.touch(sender, true);
          break;
      }
    } catch (error) {
      console.error("Error handling message", error);
    }
  }

  onClose(connection: Connection<Presence>) {
    return this.removePlayer(connection);
  }

  /**
   * partyserver routes a clean disconnect to `onClose`, but a mid-connection
   * transport failure (dropped wifi, slept laptop, lost radio) to `onError`.
   * Both tear the connection down, so both must reap the player — otherwise the
   * error path leaks a ghost that keeps occupying a slot against the room cap.
   */
  onError(connection: Connection<Presence>) {
    return this.removePlayer(connection);
  }

  /**
   * Pings live connections and evicts the ones that have gone silent past the
   * eviction window. Players are the connections themselves now, so there is no
   * separate map to reconcile — a ghost with no socket cannot exist. Reschedules
   * itself until the room empties, at which point the alarm stops and the
   * Durable Object is free to shut down.
   */
  async onAlarm() {
    const now = Date.now();
    const pingMessage = JSON.stringify({ type: "ping" } satisfies ServerMessage);
    const stale: Connection<Presence>[] = [];

    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      // Not-yet-admitted connections (room_full, closing) aren't players; leave them.
      if (!presence) continue;

      if (now - presence.aliveAt > EVICTION_TIMEOUT_MS) {
        stale.push(connection);
        continue;
      }
      try {
        connection.send(pingMessage);
      } catch {
        // A send to a socket whose peer is already gone throws — reap it, and
        // don't let one dead connection abort the sweep (and its reschedule).
        stale.push(connection);
      }
    }

    // Evict unreachable peers. Closing may not fire `onClose` for a peer that is
    // already gone, so reap explicitly; `removePlayer` is idempotent if it does.
    for (const connection of stale) {
      try {
        connection.close(1001, "idle");
      } catch {
        /* already gone */
      }
      await this.removePlayer(connection);
    }

    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    // Reschedule while any connection is still open. Read that from the socket
    // set (restored across hibernation) rather than an in-memory count, so the
    // ping loop can never stall and starve live idle clients of their pings.
    let hasConnections = false;
    for (const _connection of this.getConnections()) {
      hasConnections = true;
      break;
    }
    if (!hasConnections) return;

    const pending = await this.ctx.storage.getAlarm();
    if (pending !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }

  /**
   * HTTP room inspection: `GET /parties/vg-server/:room` returns aggregate
   * stats for that room. Rooms are addressed by guessable slugs and games are
   * untrusted code, so this exposes counts only — never player ids, colors, or
   * game state. Inspecting a room wakes its Durable Object; with no open
   * connections it goes right back to sleep.
   */
  onRequest(request: Request): Response {
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return Response.json({
      room: this.name,
      playerCount: this.playerCount(),
      capacity: this.cap,
      hasHost: this.hostId !== null,
    });
  }

  private async removePlayer(connection: Connection<Presence>): Promise<void> {
    // A connection refused at capacity (room_full) is closed before being
    // admitted, so it carries no presence and no client saw it join. Skip the
    // announce so we don't broadcast a spurious player_left. `player_left` is
    // idempotent on the client anyway, so a trailing onClose after a sweep is
    // harmless.
    if (!connection.state) return;
    const id = connection.id;
    this.snapshots.delete(id);

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id },
    };
    this.broadcast(JSON.stringify(leftMessage), [id]);

    // Remaining admitted players, now that this connection is torn down.
    let firstRemaining: string | null = null;
    let remainingCount = 0;
    for (const other of this.getConnections<Presence>()) {
      if (other.id === id || !other.state) continue;
      remainingCount++;
      if (firstRemaining === null || other.id < firstRemaining) firstRemaining = other.id;
    }

    if (this.hostId === id) {
      await this.setHostId(firstRemaining);
      if (firstRemaining) {
        const hostMessage: ServerMessage = {
          type: "host",
          data: { id: firstRemaining },
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    // Reset the sticky cap AND the shared state once the room empties so the
    // next session starts fresh. Otherwise state set by an earlier session
    // outlives it on the (still-warm) Durable Object: a wrong cap for a session
    // that wants the unlimited default, and ghost world state (eaten pellets,
    // scores, farm tiles) that the next session's clients adopt before their new
    // host's first broadcast.
    if (remainingCount === 0) {
      await this.setCap(null);
      this.shared = {};
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Liveness probe. Answered at the Worker layer so it never wakes a
    // Durable Object — cheap enough for an uptime monitor to hammer.
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "vibedgames-party" });
    }
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
