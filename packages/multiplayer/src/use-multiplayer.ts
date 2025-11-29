import { useEffect, useMemo, useRef } from "react";

import type { MultiplayerOptions } from "./types";
import type { MultiplayerRoom } from "./use-multiplayer-room";
import { useMultiplayerRoom } from "./use-multiplayer-room";

export function useMultiplayerState<
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(
  roomOrConfig:
    | MultiplayerRoom<TShared>
    | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): readonly [
  TShared,
  MultiplayerRoom<TShared>["updateSharedState"],
  MultiplayerRoom<TShared>,
] {
  const room = useRoom(roomOrConfig, initialState);
  const initialStateApplied = useRef(false);

  useEffect(() => {
    if (
      room.hostId === room.playerId &&
      room.playerId !== null &&
      initialState &&
      !initialStateApplied.current
    ) {
      initialStateApplied.current = true;
      room.updateSharedState((prev) => ({ ...initialState, ...prev }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit `room` to avoid infinite loop
  }, [room.hostId, room.playerId, room.updateSharedState, initialState]);

  return useMemo(
    () => [room.sharedState as TShared, room.updateSharedState, room] as const,
    [room],
  );
}

export function usePlayerState<TPlayerState = Record<string, unknown>>(
  roomOrConfig:
    | MultiplayerRoom
    | (MultiplayerOptions & { initialState?: Record<string, unknown> }),
  initialState?: TPlayerState,
): readonly [
  TPlayerState,
  MultiplayerRoom["updateMyState"],
  MultiplayerRoom<Record<string, unknown>>,
] {
  const room = useRoom(roomOrConfig, undefined);
  const initialStateApplied = useRef(false);

  const playerState = useMemo(() => {
    const state = room.playerId
      ? (room.players[room.playerId]?.state as TPlayerState | undefined)
      : undefined;
    return state ?? initialState ?? ({} as TPlayerState);
  }, [initialState, room.playerId, room.players]);

  useEffect(() => {
    if (initialState && room.playerId && !initialStateApplied.current) {
      initialStateApplied.current = true;
      room.updateMyState((prev) => ({ ...initialState, ...prev }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit `room` to avoid infinite loop
  }, [room.playerId, room.updateMyState, initialState]);

  return useMemo(
    () => [playerState, room.updateMyState, room] as const,
    [playerState, room],
  );
}

export function useIsHost(
  roomOrConfig:
    | MultiplayerRoom
    | (MultiplayerOptions & { initialState?: Record<string, unknown> }),
): boolean {
  const room = useRoom(roomOrConfig, undefined);
  return room.hostId !== null && room.hostId === room.playerId;
}

function useRoom<
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(
  roomOrConfig:
    | MultiplayerRoom<TShared>
    | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): MultiplayerRoom<TShared> {
  if ("connectionStatus" in roomOrConfig) {
    return roomOrConfig;
  }

  return useMultiplayerRoom<TShared>({
    host: roomOrConfig.host,
    party: roomOrConfig.party,
    room: roomOrConfig.room,
    initialState: initialState ?? roomOrConfig.initialState,
  });
}
