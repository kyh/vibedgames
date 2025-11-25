import { useEffect, useMemo } from "react";

import { useMultiplayerRoom, type MultiplayerRoom } from "./use-multiplayer-room";
import type { MultiplayerOptions } from "./types";

export function useMultiplayerState<
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(
  roomOrConfig:
    | MultiplayerRoom<TShared>
    | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): readonly [TShared, MultiplayerRoom<TShared>["updateSharedState"], MultiplayerRoom<TShared>] {
  const room = useRoom(roomOrConfig, initialState);

  useEffect(() => {
    if (room.hostId === room.playerId && initialState) {
      room.updateSharedState((prev) => ({ ...initialState, ...prev } as TShared));
    }
  }, [initialState, room]);

  return useMemo(() => [room.sharedState as TShared, room.updateSharedState, room] as const, [
    room,
  ]);
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
  const playerState = useMemo(() => {
    const state = room.playerId
      ? (room.players[room.playerId]?.state as TPlayerState | undefined)
      : undefined;
    return state ?? (initialState ?? ({} as TPlayerState));
  }, [initialState, room.playerId, room.players]);

  useEffect(() => {
    if (initialState && room.playerId) {
      room.updateMyState((prev) => ({ ...initialState, ...prev }));
    }
  }, [initialState, room]);

  return useMemo(() => [playerState, room.updateMyState, room] as const, [
    playerState,
    room,
  ]);
}

export function useIsHost(
  roomOrConfig:
    | MultiplayerRoom
    | (MultiplayerOptions & { initialState?: Record<string, unknown> }),
): boolean {
  const room = useRoom(roomOrConfig, undefined);
  return room.hostId !== null && room.hostId === room.playerId;
}

function useRoom<TShared extends Record<string, unknown> = Record<string, unknown>>(
  roomOrConfig:
    | MultiplayerRoom<TShared>
    | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): MultiplayerRoom<TShared> {
  if ("connectionStatus" in roomOrConfig) {
    return roomOrConfig as MultiplayerRoom<TShared>;
  }

  return useMultiplayerRoom<TShared>({
    host: roomOrConfig.host,
    party: roomOrConfig.party,
    room: roomOrConfig.room,
    initialState: initialState ?? roomOrConfig.initialState,
  });
}
