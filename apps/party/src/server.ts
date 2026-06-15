import type { Connection, ConnectionContext } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type { ClientMessage, Player, PlayerMap, ServerMessage } from "@vibedgames/multiplayer";
import { HOST_LIVENESS_TIMEOUT_MS, ROOM_CAP_QUERY_PARAM } from "@vibedgames/multiplayer";
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
  /** Last time (ms) we heard anything from each connection — drives host-liveness
   *  migration when a host vanishes ungracefully (sleep/crash/network drop). */
  lastSeen: Record<string, number>;
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
      .filter((id) => id !== host && now - (this.room.lastSeen[id] ?? 0) <= HOST_LIVENESS_TIMEOUT_MS)
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

      // any message proves this connection is alive
      this.room.lastSeen[sender.id] = Date.now();

      const message = JSON.parse(rawMessage) as ClientMessage;

      switch (message.type) {
        case "heartbeat":
          // liveness only — the lastSeen bump above is the whole point
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
    // A connection refused at capacity (room_full) is closed before being
    // admitted, so it was never in `players` and no client saw it join.
    // Skip the cleanup/announce so we don't broadcast a spurious player_left.
    if (!this.room.players[connection.id]) return;

    delete this.room.players[connection.id];
    delete this.room.lastSeen[connection.id];
    const remainingIds = Object.keys(this.room.players);

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id: connection.id },
    };
    this.broadcast(JSON.stringify(leftMessage), []);

    if (this.room.hostId === connection.id) {
      this.room.hostId = remainingIds[0] ?? null;
      if (this.room.hostId) {
        const hostMessage: ServerMessage = {
          type: "host",
          data: { id: this.room.hostId },
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    // Reset the sticky cap once the room empties so the next session
    // re-establishes it from whoever joins first. Otherwise a cap set by an
    // earlier session would outlive it on the (still-warm) Durable Object and
    // wrongly cap a later session that wants the unlimited default.
    if (remainingIds.length === 0) {
      this.room.cap = null;
      this.room.lastSeen = {};
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
