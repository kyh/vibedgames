import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type {
  JsonRecord,
  JsonValue,
  MultiplayerOptions,
  PlayerMap,
  SendEventOptions,
} from "./types.js";
import { MultiplayerClient } from "./client.js";
import type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client.js";

// ---------------------------------------------------------------------------
// Core room hook
// ---------------------------------------------------------------------------

/** Functional-updater forms accepted by `updateSharedState`. */
type SharedUpdaterFn<TShared> =
  | ((previous: TShared) => TShared)
  | ((previous: TShared) => Partial<TShared>);

// instanceof rather than typeof (banned): updaters are always constructed in
// the caller's realm alongside the hook, so the realm caveat doesn't bite.
const isSharedUpdaterFn = <TShared>(
  updater: Partial<TShared> | SharedUpdaterFn<TShared>,
): updater is SharedUpdaterFn<TShared> => updater instanceof Function;

export type MultiplayerRoom<TShared = JsonRecord> = MultiplayerSnapshot & {
  sharedState: TShared;
  updateSharedState: (updater: Partial<TShared> | SharedUpdaterFn<TShared>) => void;
  updateMyState: (updater: JsonRecord | ((previous: JsonRecord) => JsonRecord)) => void;
  sendEvent: (event: string, payload: JsonValue, options?: SendEventOptions) => void;
};

export type UseMultiplayerRoomConfig<TShared> = MultiplayerOptions & {
  initialState?: TShared;
};

export function useMultiplayerRoom<TShared extends JsonRecord = JsonRecord>(
  config: UseMultiplayerRoomConfig<TShared>,
): MultiplayerRoom<TShared> {
  const onEventRef = useRef(config.onEvent);
  onEventRef.current = config.onEvent;

  // Stable client instance — only recreate if connection params change
  const clientRef = useRef<MultiplayerClient | null>(null);
  const key = `${config.host}/${config.party}/${config.room}/${config.maxPlayers ?? ""}`;
  const keyRef = useRef(key);

  if (!clientRef.current || keyRef.current !== key) {
    clientRef.current?.destroy();
    keyRef.current = key;
    clientRef.current = new MultiplayerClient({
      host: config.host,
      party: config.party,
      room: config.room,
      maxPlayers: config.maxPlayers,
      initialState: config.initialState,
      onEvent: (event, payload, from) => onEventRef.current?.(event, payload, from),
    });
  }

  const client = clientRef.current;

  // Keep onEvent in sync
  useEffect(() => {
    client.onEvent = (event, payload, from) => onEventRef.current?.(event, payload, from);
  }, [client]);

  // Clean up on unmount
  useEffect(
    () => () => {
      clientRef.current?.destroy();
    },
    [],
  );

  // Subscribe to client state via useSyncExternalStore
  const subscribe = useCallback((cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const updateSharedState = useCallback(
    (updater: Partial<TShared> | SharedUpdaterFn<TShared>) => {
      if (isSharedUpdaterFn(updater)) {
        // SAFETY: the room's shared state is written and read solely through
        // this hook's TShared-typed API — the untyped client only relays it,
        // so the stored JsonRecord is the TShared the game last produced.
        client.updateSharedState((prev) => (updater as (p: TShared) => TShared)(prev as TShared));
      } else {
        // SAFETY: a Partial<TShared> patch is shallow-merged into the current
        // TShared; `undefined` values are dropped key-wise by JSON on send.
        client.updateSharedState(updater as TShared);
      }
    },
    [client],
  );

  const updateMyState = useCallback(
    (updater: JsonRecord | ((previous: JsonRecord) => JsonRecord)) => {
      client.updateMyState(updater);
    },
    [client],
  );

  const sendEvent = useCallback(
    (event: string, payload: JsonValue, options?: SendEventOptions) =>
      client.sendEvent(event, payload, options),
    [client],
  );

  return useMemo(
    () => ({
      ...snapshot,
      // SAFETY: same invariant as updateSharedState — the stored JsonRecord is
      // whatever TShared the game seeded and last wrote.
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

export function useMultiplayerState<TShared extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): readonly [TShared, MultiplayerRoom<TShared>["updateSharedState"], MultiplayerRoom<TShared>] {
  const room = useRoom(roomOrConfig, initialState);
  // Track which player identity we've seeded for, not a lifetime boolean: an
  // overflow redirect (room_full) hands the client a fresh playerId, and the
  // new room needs seeding too. playerId is stable across host promotion, so
  // this still won't re-seed a promoted guest (the documented footgun).
  const seededForPlayer = useRef<string | null>(null);

  useEffect(() => {
    if (
      room.hostId === room.playerId &&
      room.playerId !== null &&
      initialState &&
      seededForPlayer.current !== room.playerId
    ) {
      seededForPlayer.current = room.playerId;
      room.updateSharedState((prev) => ({ ...initialState, ...prev }));
    }
  }, [room.hostId, room.playerId, room.updateSharedState, initialState]);

  return useMemo(() => [room.sharedState, room.updateSharedState, room] as const, [room]);
}

export function usePlayerState<TPlayerState extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: JsonRecord }),
  initialState?: TPlayerState,
): readonly [TPlayerState, MultiplayerRoom["updateMyState"], MultiplayerRoom<JsonRecord>] {
  const room = useRoom(roomOrConfig, undefined);
  // Per-player-identity seeding, same as useMultiplayerState above.
  const seededForPlayer = useRef<string | null>(null);

  const playerState = useMemo(() => {
    // SAFETY: a player's state is only ever written through this hook's
    // TPlayerState-typed setter — the untyped client just relays it.
    const state = room.playerId
      ? (room.players[room.playerId]?.state as TPlayerState | undefined)
      : undefined;
    // SAFETY: `{}` is the documented empty-room starting state for any
    // player-state shape (states start empty by protocol).
    return state ?? initialState ?? ({} as TPlayerState);
  }, [initialState, room.playerId, room.players]);

  useEffect(() => {
    if (initialState && room.playerId && seededForPlayer.current !== room.playerId) {
      seededForPlayer.current = room.playerId;
      room.updateMyState((prev) => ({ ...initialState, ...prev }));
    }
  }, [room.playerId, room.updateMyState, initialState]);

  return useMemo(() => [playerState, room.updateMyState, room] as const, [playerState, room]);
}

export function useIsHost(
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: JsonRecord }),
): boolean {
  const room = useRoom(roomOrConfig, undefined);
  return room.hostId !== null && room.hostId === room.playerId;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function useRoom<TShared extends JsonRecord = JsonRecord>(
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
    maxPlayers: roomOrConfig.maxPlayers,
    initialState: initialState ?? roomOrConfig.initialState,
  });
}
