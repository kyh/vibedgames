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

type RoomState = {
  sharedState: Record<string, unknown>;
  players: PlayerMap;
  hostId: string | null;
  /**
   * The room's player cap, established by the first connection that advertises
   * one and sticky thereafter, so a later join that omits the query param
   * can't bypass it. `null` means no cap was ever advertised (unlimited).
   */
  cap: number | null;
  /** Last time (ms) we heard anything *except a pong* from each connection —
   *  drives host-liveness migration when a host vanishes ungracefully
   *  (sleep/crash/network drop) or is merely backgrounded. Pongs are excluded on
   *  purpose: a hidden tab still pongs, and must still lose the host role. */
  lastSeen: Record<string, number>;
  /** Last time (ms) we heard *anything at all*, pongs included — drives eviction.
   *  A hidden tab keeps this fresh, so backgrounding never removes a player. */
  lastAlive: Record<string, number>;
};

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
  private room: RoomState = {
    sharedState: {},
    players: {},
    hostId: null,
    cap: null,
    lastSeen: {},
    lastAlive: {},
  };

  /** Migrate host off a connection we haven't heard from within the liveness
   *  window (it vanished without a clean close). Picks the lowest-id live peer
   *  for determinism. No-op while the host is responsive or no live peer exists. */
  private checkHostLiveness(): void {
    const host = this.room.hostId;
    if (!host) return;
    const now = Date.now();
    if (now - (this.room.lastSeen[host] ?? 0) <= HOST_LIVENESS_TIMEOUT_MS) return;
    const next = Object.keys(this.room.players)
      .filter(
        (id) => id !== host && now - (this.room.lastSeen[id] ?? 0) <= HOST_LIVENESS_TIMEOUT_MS,
      )
      .sort()[0];
    if (!next) return; // nobody healthier to hand off to — keep the current host
    this.room.hostId = next;
    this.room.lastSeen[next] = now; // grace, so we don't immediately re-migrate
    const hostMessage: ServerMessage = { type: "host", data: { id: next } };
    this.broadcast(JSON.stringify(hostMessage), []);
  }

  onConnect(connection: Connection<Player>, ctx: ConnectionContext) {
    // The room's effective cap for this admission decision: the sticky cap an
    // earlier admitted client established, or — if none yet — the cap this
    // client advertises. We don't persist the requested cap until we've
    // decided to admit (below), so a refused over-cap join can't retroactively
    // cap a room that never accepted it — which would otherwise also bounce
    // later, even uncapped, joins to overflow.
    const requestedCap = readRoomCap(ctx);
    const cap = this.room.cap ?? requestedCap;

    // Enforce the room cap before admitting the player. If full, point the
    // client at the overflow sibling and close — the SDK reconnects there.
    if (cap !== null && Object.keys(this.room.players).length >= cap) {
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
    if (this.room.cap === null && requestedCap !== null) {
      this.room.cap = requestedCap;
    }

    const { color, hue } = getColorById(connection.id);
    const player: Player = {
      id: connection.id,
      color,
      hue,
      state: {},
    };

    this.room.players[connection.id] = player;
    this.room.lastSeen[connection.id] = Date.now();
    this.room.lastAlive[connection.id] = Date.now();
    void this.scheduleSweep();
    if (!this.room.hostId) {
      this.room.hostId = connection.id;
    }
    // a fresh join is a good moment to evict a host that vanished while the room
    // was idle — so the newcomer lands in a live game, not a frozen one
    this.checkHostLiveness();

    const syncMessage: ServerMessage = {
      type: "sync",
      data: {
        players: this.room.players,
        state: this.room.sharedState,
        hostId: this.room.hostId!,
      },
    };
    connection.send(JSON.stringify(syncMessage));

    const joinedMessage: ServerMessage = {
      type: "player_joined",
      data: player,
    };
    this.broadcast(JSON.stringify(joinedMessage), [connection.id]);
  }

  onMessage(sender: Connection<Player>, rawMessage: string): void | Promise<void> {
    try {
      // Ignore messages from connections that were never admitted — e.g. a
      // capacity-refused connection that sends in the window before its close
      // settles. Such a connection isn't in `players`, so it must not be able
      // to broadcast state or events into the room.
      if (!this.room.players[sender.id]) return;

      const message = JSON.parse(rawMessage) as ClientMessage;

      // Any message at all proves the peer is reachable, so it defers eviction.
      this.room.lastAlive[sender.id] = Date.now();
      // But only a non-pong message proves the tab is actually *running*. A
      // hidden tab still answers pings from its message handler while its rAF
      // heartbeat is paused, so counting pongs here would keep a backgrounded
      // host in the host seat forever — the exact thing host-liveness prevents.
      if (message.type !== "pong") {
        this.room.lastSeen[sender.id] = Date.now();
      }

      switch (message.type) {
        case "heartbeat":
        case "pong":
          // liveness only — the timestamp bumps above are the whole point
          break;
        case "state_patch": {
          // Shared state is host-authoritative: only the elected host
          // can write. Non-host writes get a `state` echo back so the
          // client can rewind its local mirror, and we drop the patch
          // instead of relaying it.
          if (sender.id !== this.room.hostId) {
            const echo: ServerMessage = {
              type: "state_patch",
              data: this.room.sharedState,
            };
            sender.send(JSON.stringify(echo));
            break;
          }
          this.room.sharedState = {
            ...this.room.sharedState,
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
          const player = this.room.players[sender.id];
          if (!player) return;

          player.state = { ...player.state, ...message.data };
          this.room.players[sender.id] = player;

          const updateMessage: ServerMessage = {
            type: "player_state",
            data: { id: sender.id, state: player.state ?? {} },
          };
          this.broadcast(JSON.stringify(updateMessage), [sender.id]);
          break;
        }
        case "emit": {
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
          break;
      }

      // every inbound message is a chance to notice the host went silent and
      // hand off — guests heartbeat every ~2s, so this fires often enough.
      this.checkHostLiveness();
    } catch (error) {
      console.error("Error handling message", error);
    }
  }

  onClose(connection: Connection<Player>) {
    this.removePlayer(connection.id);
  }

  /**
   * partyserver routes a clean disconnect to `onClose`, but a mid-connection
   * transport failure (dropped wifi, slept laptop, lost radio) to `onError`.
   * Both tear the connection down, so both must reap the player — otherwise the
   * error path leaks a ghost that keeps occupying a slot against the room cap.
   */
  onError(connection: Connection<Player>) {
    this.removePlayer(connection.id);
  }

  /**
   * Pings live connections and evicts the ones that have gone silent past the
   * eviction window, then reconciles `players` against the connections that
   * actually exist. Reschedules itself until the room empties, at which point
   * the alarm stops and the Durable Object is free to shut down.
   */
  async onAlarm() {
    const now = Date.now();
    const pingMessage: ServerMessage = { type: "ping" };
    const liveIds = new Set<string>();
    const stale: Connection<Player>[] = [];

    for (const connection of this.getConnections<Player>()) {
      liveIds.add(connection.id);
      // Not-yet-admitted connections (room_full, closing) aren't players; leave them.
      if (!this.room.players[connection.id]) continue;

      const aliveAt = this.room.lastAlive[connection.id] ?? now;
      if (now - aliveAt > EVICTION_TIMEOUT_MS) stale.push(connection);
      else connection.send(JSON.stringify(pingMessage));
    }

    // Evict unreachable peers. Closing may not fire `onClose` for a peer that is
    // already gone, so reap explicitly; `removePlayer` is idempotent if it does.
    for (const connection of stale) {
      connection.close(1001, "idle");
      this.removePlayer(connection.id);
    }

    // Belt and braces: a player with no live connection behind it can only be a
    // ghost, whatever teardown path we missed. This makes the leak unrecoverable
    // by construction rather than relying on every hook firing.
    for (const id of Object.keys(this.room.players)) {
      if (!liveIds.has(id)) this.removePlayer(id);
    }

    await this.scheduleSweep();
  }

  private async scheduleSweep() {
    if (Object.keys(this.room.players).length === 0) return;
    const pending = await this.ctx.storage.getAlarm();
    if (pending !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }

  private removePlayer(id: string) {
    // A connection refused at capacity (room_full) is closed before being
    // admitted, so it was never in `players` and no client saw it join. Skip the
    // cleanup/announce so we don't broadcast a spurious player_left. Doubles as
    // the idempotency guard for a connection the sweep already evicted.
    if (!this.room.players[id]) return;

    delete this.room.players[id];
    delete this.room.lastSeen[id];
    delete this.room.lastAlive[id];
    const remainingIds = Object.keys(this.room.players);

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id },
    };
    this.broadcast(JSON.stringify(leftMessage), []);

    if (this.room.hostId === id) {
      this.room.hostId = remainingIds[0] ?? null;
      if (this.room.hostId) {
        const hostMessage: ServerMessage = {
          type: "host",
          data: { id: this.room.hostId },
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    // Reset the sticky cap AND the shared state once the room empties so the
    // next session starts fresh. Otherwise state set by an earlier session
    // outlives it on the (still-warm) Durable Object: a wrong cap for a
    // session that wants the unlimited default, and ghost world state (eaten
    // pellets, scores, farm tiles) that the next session's clients adopt
    // before their new host's first broadcast.
    if (remainingIds.length === 0) {
      this.room.cap = null;
      this.room.lastSeen = {};
      this.room.lastAlive = {};
      this.room.sharedState = {};
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
