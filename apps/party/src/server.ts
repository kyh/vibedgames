import type { Connection, ConnectionContext } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type { ClientMessage, Player, PlayerMap, ServerMessage } from "@vibedgames/multiplayer";
import { ROOM_CAP_QUERY_PARAM } from "@vibedgames/multiplayer";
import { getColorById } from "./color";

type Env = {
  VgServer: DurableObjectNamespace<VgServer>;
  DB: D1Database;
};

type RoomState = {
  sharedState: Record<string, unknown>;
  players: PlayerMap;
  hostId: string | null;
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
  };

  onConnect(connection: Connection<Player>, ctx: ConnectionContext) {
    // Enforce the room cap before admitting the player. If full, point the
    // client at the overflow sibling and close — the SDK reconnects there.
    const cap = readRoomCap(ctx);
    if (cap !== null && Object.keys(this.room.players).length >= cap) {
      const fullMessage: ServerMessage = {
        type: "room_full",
        data: { room: nextOverflowRoom(this.name), capacity: cap },
      };
      connection.send(JSON.stringify(fullMessage));
      connection.close(4001, "room_full");
      return;
    }

    const { color, hue } = getColorById(connection.id);
    const player: Player = {
      id: connection.id,
      color,
      hue,
      state: {},
    };

    this.room.players[connection.id] = player;
    if (!this.room.hostId) {
      this.room.hostId = connection.id;
    }

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
      const message = JSON.parse(rawMessage) as ClientMessage;

      switch (message.type) {
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

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id: connection.id },
    };
    this.broadcast(JSON.stringify(leftMessage), []);

    if (this.room.hostId === connection.id) {
      const remainingIds = Object.keys(this.room.players);
      this.room.hostId = remainingIds[0] ?? null;
      if (this.room.hostId) {
        const hostMessage: ServerMessage = {
          type: "host",
          data: { id: this.room.hostId },
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
