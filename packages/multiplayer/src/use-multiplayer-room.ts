import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import usePartySocket from "partysocket/react";

import type {
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  MultiplayerRoomState,
  Player,
  PlayerMap,
  ServerMessage,
} from "./types";

export type MultiplayerRoom<TShared = Record<string, unknown>> =
  MultiplayerRoomState & {
    sharedState: TShared;
    updateSharedState: (
      updater:
        | Partial<TShared>
        | ((previous: TShared) => TShared)
        | ((previous: TShared) => Partial<TShared>),
    ) => void;
    updateMyState: (
      updater:
        | Record<string, unknown>
        | ((previous: Record<string, unknown>) => Record<string, unknown>),
    ) => void;
    sendEvent: (event: string, payload: unknown) => void;
  };

export type UseMultiplayerRoomConfig<TShared> = MultiplayerOptions & {
  initialState?: TShared;
};

export function useMultiplayerRoom<
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(
  config: UseMultiplayerRoomConfig<TShared>,
): MultiplayerRoom<TShared> {
  const socket = usePartySocket({
    host: config.host,
    party: config.party,
    room: config.room,
  });

  const [connectionStatus, setConnectionStatus] = useState<
    MultiplayerConnectionStatus
  >("connecting");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [sharedState, setSharedState] = useState<TShared>(
    () => config.initialState ?? ({} as TShared),
  );
  const [players, setPlayers] = useState<PlayerMap>({});

  const sharedStateRef = useRef<TShared>(sharedState);
  const playersRef = useRef<PlayerMap>({});
  const initialStateApplied = useRef(false);

  sharedStateRef.current = sharedState;
  playersRef.current = players;

  const applyPatch = useCallback(<T extends Record<string, unknown>>(
    current: T,
    patch: Partial<T> | ((previous: T) => Partial<T> | T),
  ): T => {
    const nextValue = typeof patch === "function" ? patch(current) : patch;
    return { ...current, ...(nextValue as Partial<T>) } as T;
  }, []);

  useEffect(() => {
    const handleOpen = () => {
      setConnectionStatus("connected");
      setPlayerId(socket.id ?? null);
    };

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        switch (message.type) {
          case "sync": {
            setHostId(message.data.hostId);
            setPlayers(message.data.players);
            setSharedState((prev: TShared) =>
              Object.keys(prev ?? {}).length === 0
                ? (message.data.state as TShared)
                : { ...prev, ...(message.data.state as Partial<TShared>) },
            );

            if (
              message.data.hostId === socket.id &&
              !initialStateApplied.current &&
              config.initialState
            ) {
              initialStateApplied.current = true;
              const patchMessage: ClientMessage = {
                type: "state_patch",
                data: config.initialState as Record<string, unknown>,
              };
              socket.send(JSON.stringify(patchMessage));
            }
            break;
          }
          case "player_joined": {
            setPlayers((prev: PlayerMap) => ({
              ...prev,
              [message.data.id]: message.data as Player,
            }));
            break;
          }
          case "player_left": {
            setPlayers((prev: PlayerMap) => {
              const updated = { ...prev };
              delete updated[message.data.id];
              return updated;
            });
            break;
          }
          case "host": {
            setHostId(message.data.id);
            if (
              message.data.id === socket.id &&
              config.initialState &&
              !initialStateApplied.current
            ) {
              initialStateApplied.current = true;
              socket.send(
                JSON.stringify({
                  type: "state_patch",
                  data: config.initialState as Record<string, unknown>,
                } satisfies ClientMessage),
              );
            }
            break;
          }
          case "state_patch": {
            setSharedState((prev: TShared) => ({
              ...prev,
              ...(message.data as Partial<TShared>),
            }));
            break;
          }
          case "player_state": {
            setPlayers((prev: PlayerMap) => {
              const existing = prev[message.data.id] ?? { id: message.data.id };
              return {
                ...prev,
                [message.data.id]: {
                  ...existing,
                  state: message.data.state,
                },
              } satisfies PlayerMap;
            });
            break;
          }
          case "event": {
            // Events are user-defined; they can be handled through sendEvent
            break;
          }
          default:
            break;
        }
      } catch (error) {
        console.error("Failed to process multiplayer message", error);
      }
    };

    const handleClose = () => setConnectionStatus("disconnected");
    const handleError = () => setConnectionStatus("error");

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
    };
  }, [config.initialState, socket]);

  const updateSharedState = useCallback(
    (
      updater:
        | Partial<TShared>
        | ((previous: TShared) => TShared)
        | ((previous: TShared) => Partial<TShared>),
    ) => {
      const next = applyPatch(sharedStateRef.current as TShared, updater);
      setSharedState(next);
      const message: ClientMessage = {
        type: "state_patch",
        data: next as Record<string, unknown>,
      };
      socket.send(JSON.stringify(message));
    },
    [applyPatch, socket],
  );

  const updateMyState = useCallback(
    (
      updater:
        | Record<string, unknown>
        | ((previous: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      const currentPlayerState =
        (playerId && (playersRef.current[playerId]?.state as Record<string, unknown>)) || {};
      const nextState = applyPatch(currentPlayerState, updater);
      setPlayers((prev: PlayerMap) => {
        if (!playerId) return prev;

        const existing = prev[playerId] ?? { id: playerId };
        return {
          ...prev,
          [playerId]: {
            ...existing,
            state: nextState,
          },
        } satisfies PlayerMap;
      });

      const message: ClientMessage = {
        type: "player_state_patch",
        data: nextState,
      };
      socket.send(JSON.stringify(message));
    },
    [applyPatch, playerId, socket],
  );

  const sendEvent = useCallback(
    (event: string, payload: unknown) => {
      const message: ClientMessage = {
        type: "emit",
        data: { event, payload },
      };
      socket.send(JSON.stringify(message));
    },
    [socket],
  );

  return useMemo(
    () => ({
      connectionStatus,
      playerId,
      hostId,
      sharedState,
      players,
      updateSharedState,
      updateMyState,
      sendEvent,
    }),
    [connectionStatus, hostId, playerId, players, sendEvent, sharedState, updateMyState, updateSharedState],
  );
}
