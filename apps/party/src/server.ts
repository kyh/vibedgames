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
 * The player as stored on its connection. The two liveness clocks live here,
 * on the socket's attachment, rather than in an instance-level map — see the
 * class comment for why that matters under hibernation.
 *
 * - `lastAlive`: last time we heard *anything at all*, pongs included — drives
 *   eviction. A hidden tab keeps this fresh, so backgrounding never removes a
 *   player.
 * - `lastSeen`: last time we heard anything *except a pong* — drives
 *   host-liveness migration when a host vanishes ungracefully or is merely
 *   backgrounded. Pongs are excluded on purpose: a hidden tab still pongs, and
 *   must still lose the host role.
 */
type StoredPlayer = Player & { lastSeen: number; lastAlive: number };

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
   * and its instance destroyed, but the open sockets — and their serialized
   * attachments — survive.
   *
   * - Players and their liveness clocks live on each connection's attachment
   *   (see `StoredPlayer`), NOT in an instance map. A parallel `players` map
   *   was emptied on every hibernation, after which `onMessage` dropped every
   *   surviving connection's messages (they were no longer "admitted"), freezing
   *   those players into ghosts that could never move or be evicted. Deriving
   *   players from the live sockets makes that unrepresentable.
   * - `hostId` and `cap` change rarely but MUST persist: a wiped `hostId` makes
   *   the real host's `state_patch` get rejected as non-host after a wake; a
   *   wiped `cap` lets a post-wake join exceed it. They're mirrored in memory
   *   and written through to storage, and rehydrated in `onStart()`.
   * - `sharedState` is host-authoritative game state streamed ~30×/s. It is
   *   intentionally NOT persisted: the room only hibernates when idle (nobody
   *   streaming), and the host re-establishes it within a tick on resume — and
   *   clients re-send on reconnect. Persisting it would be pure write
   *   amplification.
   */
  private sharedState: Record<string, unknown> = {};
  private hostId: string | null = null;
  private cap: number | null = null;

  /** Rehydrate durable fields before any handler runs (partyserver awaits this). */
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

  /** The stored player for a connection id, or undefined if not admitted. */
  private storedPlayer(id: string): StoredPlayer | undefined {
    for (const connection of this.getConnections<StoredPlayer>()) {
      if (connection.id === id) return connection.state ?? undefined;
    }
    return undefined;
  }

  /** Public player map (no liveness fields) derived from the live sockets. */
  private players(): PlayerMap {
    const players: PlayerMap = {};
    for (const connection of this.getConnections<StoredPlayer>()) {
      const stored = connection.state;
      if (stored) players[connection.id] = this.toPlayer(stored);
    }
    return players;
  }

  private toPlayer(stored: StoredPlayer): Player {
    return { id: stored.id, color: stored.color, hue: stored.hue, state: stored.state };
  }

  /** Count of admitted players (connections carrying state), optionally minus one. */
  private playerCount(excludeId?: string): number {
    let count = 0;
    for (const connection of this.getConnections<StoredPlayer>()) {
      if (connection.id === excludeId) continue;
      if (connection.state) count++;
    }
    return count;
  }

  /** Migrate host off a connection we haven't heard from within the liveness
   *  window (it vanished without a clean close). Picks the lowest-id live peer
   *  for determinism. No-op while the host is responsive or no live peer exists. */
  private async checkHostLiveness(): Promise<void> {
    const host = this.hostId;
    if (!host) return;
    const now = Date.now();
    const hostStored = this.storedPlayer(host);
    if (hostStored && now - hostStored.lastSeen <= HOST_LIVENESS_TIMEOUT_MS) return;

    let next: Connection<StoredPlayer> | null = null;
    for (const connection of this.getConnections<StoredPlayer>()) {
      const stored = connection.state;
      if (!stored || connection.id === host) continue;
      if (now - stored.lastSeen > HOST_LIVENESS_TIMEOUT_MS) continue;
      if (!next || connection.id < next.id) next = connection;
    }
    if (!next) return; // nobody healthier to hand off to — keep the current host

    // Grace on the new host so we don't immediately re-migrate.
    const stored = next.state;
    if (stored) next.setState({ ...stored, lastSeen: now });
    await this.setHostId(next.id);
    const hostMessage: ServerMessage = { type: "host", data: { id: next.id } };
    this.broadcast(JSON.stringify(hostMessage), []);
  }

  async onConnect(connection: Connection<StoredPlayer>, ctx: ConnectionContext) {
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
    const stored: StoredPlayer = {
      id: connection.id,
      color,
      hue,
      state: {},
      lastSeen: now,
      lastAlive: now,
    };
    connection.setState(stored);
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
        state: this.sharedState,
        hostId: this.hostId ?? connection.id,
      },
    };
    connection.send(JSON.stringify(syncMessage));

    const joinedMessage: ServerMessage = {
      type: "player_joined",
      data: this.toPlayer(stored),
    };
    this.broadcast(JSON.stringify(joinedMessage), [connection.id]);
  }

  async onMessage(sender: Connection<StoredPlayer>, rawMessage: string): Promise<void> {
    try {
      // Ignore messages from connections that were never admitted — e.g. a
      // capacity-refused connection that sends in the window before its close
      // settles. Such a connection carries no state, so it must not be able to
      // broadcast into the room. (A connection that survived hibernation keeps
      // its attachment, so it stays admitted — no false drop.)
      const stored = sender.state;
      if (!stored) return;

      const message = JSON.parse(rawMessage) as ClientMessage;
      const now = Date.now();

      // Any message at all proves the peer is reachable, so it defers eviction.
      // But only a non-pong message proves the tab is actually *running*: a
      // hidden tab still answers pings from its message handler while its rAF
      // heartbeat is paused, so counting pongs as `lastSeen` would keep a
      // backgrounded host in the seat forever — the thing host-liveness prevents.
      // Fold both bumps into a single state write (below), including the state
      // patch when this is a player_state_patch.
      const nextSeen = message.type === "pong" ? stored.lastSeen : now;

      switch (message.type) {
        case "heartbeat":
        case "pong":
          // liveness only — the timestamp bumps are the whole point
          sender.setState({ ...stored, lastSeen: nextSeen, lastAlive: now });
          break;
        case "state_patch": {
          sender.setState({ ...stored, lastSeen: nextSeen, lastAlive: now });
          // Shared state is host-authoritative: only the elected host can
          // write. Non-host writes get a `state` echo back so the client can
          // rewind its local mirror, and we drop the patch instead of relaying.
          if (sender.id !== this.hostId) {
            const echo: ServerMessage = {
              type: "state_patch",
              data: this.sharedState,
            };
            sender.send(JSON.stringify(echo));
            break;
          }
          this.sharedState = {
            ...this.sharedState,
            ...message.data,
          };
          const broadcastMessage: ServerMessage = {
            type: "state_patch",
            data: message.data,
          };
          this.broadcast(JSON.stringify(broadcastMessage), []);
          break;
        }
        case "player_state_patch": {
          sender.setState({
            ...stored,
            state: { ...stored.state, ...message.data },
            lastSeen: nextSeen,
            lastAlive: now,
          });
          const updateMessage: ServerMessage = {
            type: "player_state",
            data: { id: sender.id, state: { ...stored.state, ...message.data } },
          };
          this.broadcast(JSON.stringify(updateMessage), [sender.id]);
          break;
        }
        case "emit": {
          sender.setState({ ...stored, lastSeen: nextSeen, lastAlive: now });
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
          sender.setState({ ...stored, lastSeen: nextSeen, lastAlive: now });
          break;
      }

      // every inbound message is a chance to notice the host went silent and
      // hand off — guests heartbeat every ~2s, so this fires often enough.
      await this.checkHostLiveness();
    } catch (error) {
      console.error("Error handling message", error);
    }
  }

  onClose(connection: Connection<StoredPlayer>) {
    return this.removePlayer(connection);
  }

  /**
   * partyserver routes a clean disconnect to `onClose`, but a mid-connection
   * transport failure (dropped wifi, slept laptop, lost radio) to `onError`.
   * Both tear the connection down, so both must reap the player — otherwise the
   * error path leaks a ghost that keeps occupying a slot against the room cap.
   */
  onError(connection: Connection<StoredPlayer>) {
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
    const stale: Connection<StoredPlayer>[] = [];

    for (const connection of this.getConnections<StoredPlayer>()) {
      const stored = connection.state;
      // Not-yet-admitted connections (room_full, closing) aren't players; leave them.
      if (!stored) continue;

      if (now - stored.lastAlive > EVICTION_TIMEOUT_MS) {
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

  private async removePlayer(connection: Connection<StoredPlayer>): Promise<void> {
    // A connection refused at capacity (room_full) is closed before being
    // admitted, so it carries no state and no client saw it join. Skip the
    // announce so we don't broadcast a spurious player_left. `player_left` is
    // idempotent on the client anyway, so a trailing onClose after a sweep is
    // harmless.
    if (!connection.state) return;
    const id = connection.id;

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id },
    };
    this.broadcast(JSON.stringify(leftMessage), [id]);

    // Remaining admitted players, now that this connection is torn down.
    let firstRemaining: string | null = null;
    let remainingCount = 0;
    for (const other of this.getConnections<StoredPlayer>()) {
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
      this.sharedState = {};
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
