import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { JsonRecord, JsonValue, MultiplayerOptions, SendEventOptions } from "./types.js";
import { MultiplayerClient } from "./client.js";
import type { MultiplayerSnapshot } from "./client.js";

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
): updater is SharedUpdaterFn<TShared> => typeof updater === "function";

export type MultiplayerRoom<TShared = JsonRecord> = MultiplayerSnapshot & {
  sharedState: TShared;
  updateSharedState: (updater: Partial<TShared> | SharedUpdaterFn<TShared>) => void;
  updateMyState: (updater: JsonRecord | ((previous: JsonRecord) => JsonRecord)) => void;
  sendEvent: (event: string, payload: JsonValue, options?: SendEventOptions) => void;
};

export type UseMultiplayerRoomConfig<TShared> = MultiplayerOptions & {
  initialState?: TShared;
};

export const useMultiplayerRoom = <TShared extends JsonRecord = JsonRecord>(
  config: UseMultiplayerRoomConfig<TShared>,
): MultiplayerRoom<TShared> => {
  // Stable client instance — only recreate if connection params change. The
  // swap happens as a render-phase state reset so the rest of this render
  // already sees the new client; the old one is torn down by effect cleanup.
  const key = `${config.host}/${config.party}/${config.room}/${config.maxPlayers ?? ""}`;
  const [entry, setEntry] = useState<{ client: MultiplayerClient; key: string } | null>(null);
  let client = entry !== null && entry.key === key ? entry.client : null;
  if (client === null) {
    client = new MultiplayerClient({
      host: config.host,
      initialState: config.initialState,
      maxPlayers: config.maxPlayers,
      onEvent: config.onEvent,
      party: config.party,
      room: config.room,
    });
    setEntry({ client, key });
  }

  useEffect(
    () => () => {
      client.destroy();
    },
    [client],
  );

  // The client outlives any one onEvent prop; keep its callback slot current.
  const { onEvent } = config;
  useEffect(() => {
    // oxlint-disable-next-line react/immutability -- the client is a socket wrapper held in state only for its identity; reassigning its callback slot is the intended API
    client.onEvent = onEvent;
  }, [client, onEvent]);

  // Subscribe to client state via useSyncExternalStore
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
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
      sendEvent,
      // SAFETY: same invariant as updateSharedState — the stored JsonRecord is
      // whatever TShared the game seeded and last wrote.
      sharedState: snapshot.sharedState as TShared,
      updateMyState,
      updateSharedState,
    }),
    [snapshot, updateSharedState, updateMyState, sendEvent],
  );
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const useRoom = <TShared extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): MultiplayerRoom<TShared> => {
  if ("connectionStatus" in roomOrConfig) {
    return roomOrConfig;
  }

  // oxlint-disable-next-line react/hooks, react-hooks/rules-of-hooks -- the argument's shape is fixed per call site (a room or a config, never both over time), so this branch is stable across renders
  return useMultiplayerRoom<TShared>({
    host: roomOrConfig.host,
    initialState: initialState ?? roomOrConfig.initialState,
    maxPlayers: roomOrConfig.maxPlayers,
    party: roomOrConfig.party,
    room: roomOrConfig.room,
  });
};

// ---------------------------------------------------------------------------
// Convenience hooks
// ---------------------------------------------------------------------------

export const useMultiplayerState = <TShared extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
): readonly [TShared, MultiplayerRoom<TShared>["updateSharedState"], MultiplayerRoom<TShared>] => {
  const room = useRoom(roomOrConfig, initialState);
  const { hostId, playerId, updateSharedState } = room;
  // Track which player identity we've seeded for, not a lifetime boolean: an
  // overflow redirect (room_full) hands the client a fresh playerId, and the
  // new room needs seeding too. playerId is stable across host promotion, so
  // this still won't re-seed a promoted guest (the documented footgun).
  const seededForPlayer = useRef<string | null>(null);

  useEffect(() => {
    if (
      hostId === playerId &&
      playerId !== null &&
      initialState &&
      seededForPlayer.current !== playerId
    ) {
      seededForPlayer.current = playerId;
      updateSharedState((prev) => ({ ...initialState, ...prev }));
    }
  }, [hostId, playerId, updateSharedState, initialState]);

  return useMemo(() => [room.sharedState, room.updateSharedState, room] as const, [room]);
};

export const usePlayerState = <TPlayerState extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: JsonRecord }),
  initialState?: TPlayerState,
): readonly [TPlayerState, MultiplayerRoom["updateMyState"], MultiplayerRoom<JsonRecord>] => {
  const room = useRoom(roomOrConfig);
  const { playerId, updateMyState } = room;
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
    if (initialState && playerId && seededForPlayer.current !== playerId) {
      seededForPlayer.current = playerId;
      updateMyState((prev) => ({ ...initialState, ...prev }));
    }
  }, [playerId, updateMyState, initialState]);

  return useMemo(() => [playerState, room.updateMyState, room] as const, [playerState, room]);
};

export const useIsHost = (
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: JsonRecord }),
): boolean => {
  const room = useRoom(roomOrConfig);
  return room.hostId !== null && room.hostId === room.playerId;
};
