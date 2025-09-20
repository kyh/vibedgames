import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren, SetStateAction } from "react";
import usePartySocket from "partysocket/react";

import { MultiplayerContext } from "./context";
import type {
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerContextValue,
  MultiplayerProviderConfig,
  Player,
  PlayerMap,
  ServerMessage,
} from "./types";

const DEFAULT_STATUS: MultiplayerConnectionStatus = "connecting";

function isUpdaterFunction<T>(value: SetStateAction<T>): value is (state: T) => T {
  return typeof value === "function";
}

export const MultiplayerProvider = <
  TShared extends Record<string, unknown> = Record<string, unknown>,
  TPlayer extends Record<string, unknown> = Record<string, unknown>,
>({
  host,
  party,
  room,
  initialSharedState,
  initialPlayerState,
  children,
}: PropsWithChildren<MultiplayerProviderConfig<TShared, TPlayer>>) => {
  const socket = usePartySocket({ host, party, room });

  const [status, setStatus] = useState<MultiplayerConnectionStatus>(DEFAULT_STATUS);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [sharedState, setSharedStateValue] = useState<TShared>(
    () => initialSharedState ?? ({} as TShared),
  );
  const [players, setPlayers] = useState<PlayerMap<TPlayer>>({});

  const sharedStateRef = useRef(sharedState);
  const applyingSharedState = useRef(false);
  const playersRef = useRef(players);
  const applyingPlayerState = useRef(false);
  const defaultPlayerStateRef = useRef<TPlayer>(initialPlayerState ?? ({} as TPlayer));

  useEffect(() => {
    if (initialPlayerState) {
      defaultPlayerStateRef.current = initialPlayerState;
    }
  }, [initialPlayerState]);

  useEffect(() => {
    sharedStateRef.current = sharedState;
  }, [sharedState]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  const applyRemoteSharedState = useCallback((nextState: TShared) => {
    applyingSharedState.current = true;
    setSharedStateValue(nextState);
    applyingSharedState.current = false;
  }, []);

  const applyRemotePlayer = useCallback(
    (player: Player<TPlayer>) => {
      applyingPlayerState.current = true;
      setPlayers((prev) => ({
        ...prev,
        [player.id]: player,
      }));
      applyingPlayerState.current = false;
    },
    [],
  );

  const sendMessage = useCallback(
    (message: ClientMessage) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify(message));
    },
    [socket],
  );

  useEffect(() => {
    const handleOpen = () => {
      setStatus("connected");
    };

    const handleClose = () => {
      setStatus("disconnected");
    };

    const handleError = () => {
      setStatus("error");
    };

    const handleMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string") {
          return;
        }

        const message = JSON.parse(event.data) as ServerMessage<TShared, TPlayer>;
        switch (message.type) {
          case "init":
            setSelfId(message.data.selfId);
            setHostId(message.data.hostId);
            applyRemoteSharedState(message.data.sharedState);
            setPlayers(message.data.players);
            break;
          case "player_joined":
            setPlayers((prev) => ({
              ...prev,
              [message.data.id]: message.data,
            }));
            break;
          case "player_left":
            setPlayers((prev) => {
              const next = { ...prev };
              delete next[message.data.id];
              return next;
            });
            break;
          case "player_updated":
            applyRemotePlayer(message.data);
            break;
          case "shared_state":
            applyRemoteSharedState(message.data);
            break;
          case "host_changed":
            setHostId(message.data.hostId);
            break;
          case "custom_event":
            break;
          default:
            break;
        }
      } catch (error) {
        console.error("@repo/multiplayer: failed to parse message", error);
      }
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    socket.addEventListener("message", handleMessage);

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("message", handleMessage);
    };
  }, [applyRemotePlayer, applyRemoteSharedState, socket]);

  const setSharedState = useCallback(
    (updater: Parameters<MultiplayerContextValue<TShared, TPlayer>["setSharedState"]>[0]) => {
      setSharedStateValue((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (!applyingSharedState.current) {
          sendMessage({ type: "set_state", data: next });
        }
        return next;
      });
    },
    [sendMessage],
  );

  const setPlayerState = useCallback(
    (updater: Parameters<MultiplayerContextValue<TShared, TPlayer>["setPlayerState"]>[0], playerId?: string) => {
      setPlayers((prev) => {
        const connectionId = playerId ?? selfId;
        if (!connectionId) {
          return prev;
        }

        const current = prev[connectionId];
        const baseState = current?.state ?? defaultPlayerStateRef.current;
        const nextState = isUpdaterFunction(updater) ? updater(baseState) : updater;
        const nextPlayer: Player<TPlayer> = current
          ? { ...current, state: nextState }
          : { id: connectionId, state: nextState };

        if (!applyingPlayerState.current && (!playerId || playerId === connectionId)) {
          sendMessage({ type: "set_player_state", data: nextState });
        }

        return {
          ...prev,
          [connectionId]: nextPlayer,
        };
      });
    },
    [selfId, sendMessage],
  );

  const getPlayerState = useCallback<
    MultiplayerContextValue<TShared, TPlayer>["getPlayerState"]
  >(
    (playerId: string) => playersRef.current[playerId]?.state,
    [],
  );

  const value = useMemo<MultiplayerContextValue<TShared, TPlayer>>(
    () => ({
      socket: socket as unknown as WebSocket,
      selfId,
      hostId,
      players,
      sharedState,
      status,
      setSharedState,
      setPlayerState,
      getPlayerState,
    }),
    [getPlayerState, hostId, players, selfId, setPlayerState, setSharedState, sharedState, socket, status],
  );

  const typedValue = value as unknown as MultiplayerContextValue<unknown, unknown>;

  return <MultiplayerContext.Provider value={typedValue}>{children}</MultiplayerContext.Provider>;
};
