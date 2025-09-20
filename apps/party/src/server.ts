import type { Connection } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type {
  ClientMessage,
  Player,
  PlayerMap,
  ServerMessage,
  SharedState,
} from "@repo/multiplayer";
import { getColorById } from "./color";

type Env = {
  VgServer: DurableObjectNamespace<VgServer>;
};

type InternalSharedState = SharedState<Record<string, unknown>>;

export class VgServer extends Server {
  private players: PlayerMap<Record<string, unknown>> = {};
  private sharedState: InternalSharedState = {};
  private hostId: string | null = null;

  onConnect(connection: Connection<Player<Record<string, unknown>>>) {
    const { color, hue } = getColorById(connection.id);
    const player: Player<Record<string, unknown>> = {
      id: connection.id,
      color,
      hue,
      state: {},
      metadata: {},
    };

    this.players[connection.id] = player;

    this.hostId ??= connection.id;

    const initMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
      type: "init",
      data: {
        selfId: connection.id,
        hostId: this.hostId,
        players: this.players,
        sharedState: this.sharedState,
      },
    };

    connection.send(JSON.stringify(initMessage));

    const joinMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
      type: "player_joined",
      data: player,
    };
    this.broadcast(JSON.stringify(joinMessage), [connection.id]);
  }

  onMessage(connection: Connection<Player<Record<string, unknown>>>, message: string) {
    try {
      const parsed = JSON.parse(message) as ClientMessage<Record<string, unknown>>;

      switch (parsed.type) {
          case "set_state": {
            this.sharedState = {
              ...parsed.data,
            };
          const stateMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
            type: "shared_state",
            data: this.sharedState,
          };
          this.broadcast(JSON.stringify(stateMessage));
          break;
        }
        case "set_player_state": {
          const player = this.players[connection.id];
          if (!player) break;

            player.state = parsed.data;
          player.lastUpdate = Date.now();
          this.players[connection.id] = player;

          const updateMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
            type: "player_updated",
            data: player,
          };
          this.broadcast(JSON.stringify(updateMessage));
          break;
        }
        case "set_metadata": {
          const player = this.players[connection.id];
          if (!player) break;

          player.metadata = {
            ...player.metadata,
            ...parsed.data,
          };
          this.players[connection.id] = player;

          const metadataMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
            type: "player_updated",
            data: player,
          };
          this.broadcast(JSON.stringify(metadataMessage));
          break;
        }
        case "emit": {
          const eventMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
            type: "custom_event",
            data: {
              event: parsed.data.event,
              payload: parsed.data.payload,
              from: connection.id,
            },
          };
          this.broadcast(JSON.stringify(eventMessage));
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.error("Failed to process multiplayer message", error);
    }
  }

  onClose(connection: Connection<Player<Record<string, unknown>>>) {
    delete this.players[connection.id];

    const leftMessage: ServerMessage<InternalSharedState, Record<string, unknown>> = {
      type: "player_left",
      data: { id: connection.id },
    };
    this.broadcast(JSON.stringify(leftMessage), []);

    if (this.hostId === connection.id) {
      this.hostId = this.pickNextHost();
      const hostChanged: ServerMessage<InternalSharedState, Record<string, unknown>> = {
        type: "host_changed",
        data: { hostId: this.hostId },
      };
      this.broadcast(JSON.stringify(hostChanged));
    }
  }

  private pickNextHost() {
    const [nextHost] = Object.keys(this.players);
    return nextHost ?? null;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return routePartykitRequest(request, env.VgServer);
  },
};
