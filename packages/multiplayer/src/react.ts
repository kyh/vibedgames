import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { MultiplayerOptions, PlayerMap } from "./types";
import { MultiplayerClient } from "./client";
import type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client";

// ---------------------------------------------------------------------------
// Core room hook
// ---------------------------------------------------------------------------

export type MultiplayerRoom<TShared = Record<string, unknown>> = MultiplayerSnapshot & {
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
>(config: UseMultiplayerRoomConfig<TShared>): MultiplayerRoom<TShared> {
  const onEventRef = useRef(config.onEvent);
  onEventRef.current = config.onEvent;

  // Stable client instance — only recreate if connection params change
  const clientRef = useRef<MultiplayerClient | null>(null);
  const keyRef = useRef(`${config.host}/${config.party}/${config.room}`);
  const key = `${config.host}/${config.party}/${config.room}`;

  if (!clientRef.current || keyRef.current !== key) {
    clientRef.current?.destroy();
    keyRef.current = key;
    clientRef.current = new MultiplayerClient({
      host: config.host,
      party: config.party,
      room: config.room,
      initialState: config.initialState as Record<string, unknown>,
      onEvent: (event, payload, from) => onEventRef.current?.(event, payload, from),
    });
  }

  const client = clientRef.current;

  // Keep onEvent in sync
  useEffect(() => {
    client.onEvent = (event, payload, from) => onEventRef.current?.(event, payload, from);
  }, [client]);

  // Clean up on unmount
  useEffect(() => () => { clientRef.current?.destroy(); }, []);

  // Subscribe to client state via useSyncExternalStore
  const subscribe = useCallback(
    (cb: () => void) => client.subscribe(cb),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const updateSharedState = useCallback(
    (
      updater:
        | Partial<TShared>
        | ((previous: TShared) => TShared)
        | ((previous: TShared) => Partial<TShared>),
    ) => {
      if (typeof updater === "function") {
        client.updateSharedState((prev) =>
          (updater as (p: TShared) => Record<string, unknown>)(prev as TShared),
        );
      } else {
        client.updateSharedState(updater as Record<string, unknown>);
      }
    },
    [client],
  );

  const updateMyState = useCallback(
    (
      updater:
        | Record<string, unknown>
        | ((previous: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      client.updateMyState(updater);
    },
    [client],
  );

  const sendEvent = useCallback(
    (event: string, payload: unknown) => client.sendEvent(event, payload),
    [client],
  );

  return useMemo(
    () => ({
      ...snapshot,
      sharedState: snapshot.sharedState as TShared,
      updateSharedState,
      updateMyState,
      sendEvent,
    }),
    [snapshot, updateSharedState, updateMyState, sendEvent],
  );
}

// ---------------------------------------------------------------------------
// Convenience hooks
// ---------------------------------------------------------------------------

export function useMultiplayerState<
  TShared extends Record<string, unknown> = Record<string, unknown>,
>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): readonly [TShared, MultiplayerRoom<TShared>["updateSharedState"], MultiplayerRoom<TShared>] {
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
  }, [room.hostId, room.playerId, room.updateSharedState, initialState]);

  return useMemo(
    () => [room.sharedState as TShared, room.updateSharedState, room] as const,
    [room],
  );
}

export function usePlayerState<TPlayerState = Record<string, unknown>>(
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: Record<string, unknown> }),
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
      room.updateMyState((prev) => ({ ...(initialState as Record<string, unknown>), ...prev }));
    }
  }, [room.playerId, room.updateMyState, initialState]);

  return useMemo(() => [playerState, room.updateMyState, room] as const, [playerState, room]);
}

export function useIsHost(
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: Record<string, unknown> }),
): boolean {
  const room = useRoom(roomOrConfig, undefined);
  return room.hostId !== null && room.hostId === room.playerId;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function useRoom<TShared extends Record<string, unknown> = Record<string, unknown>>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): MultiplayerRoom<TShared> {
  if ("connectionStatus" in roomOrConfig) {
    return roomOrConfig;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useMultiplayerRoom<TShared>({
    host: roomOrConfig.host,
    party: roomOrConfig.party,
    room: roomOrConfig.room,
    initialState: initialState ?? roomOrConfig.initialState,
  });
}
