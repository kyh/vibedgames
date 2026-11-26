import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type {
  JsonRecord,
  JsonValue,
  MultiplayerOptions,
  RoomInfo,
  SendEventOptions,
} from "./types.js";
import { MultiplayerClient } from "./client.js";
import type { MultiplayerSnapshot } from "./client.js";

/** Functional-updater forms accepted by `updateSharedState`. */
type SharedUpdaterFn<TShared> =
  | ((previous: TShared) => TShared)
  | ((previous: TShared) => Partial<TShared>);

const isSharedUpdaterFn = <TShared>(
  updater: Partial<TShared> | SharedUpdaterFn<TShared>,
): updater is SharedUpdaterFn<TShared> => typeof updater === "function";

export type MultiplayerRoom<TShared = JsonRecord> = MultiplayerSnapshot & {
  sharedState: TShared;
  updateSharedState: (updater: Partial<TShared> | SharedUpdaterFn<TShared>) => void;
  updateMyState: (updater: JsonRecord | ((previous: JsonRecord) => JsonRecord)) => void;
  sendEvent: (event: string, payload: JsonValue, options?: SendEventOptions) => void;
  /** An intent for the host alone; see `MultiplayerClient.sendToHost`. */
  sendToHost: (event: string, payload: JsonValue) => void;
  /** Leave the room and play on alone; see `MultiplayerClient.goOffline`. */
  goOffline: () => void;
  /** Host only: lock the room or set its meta; see `MultiplayerClient.setRoomInfo`. */
  setRoomInfo: (info: Partial<RoomInfo>) => void;
};

export type UseMultiplayerRoomConfig<TShared> = MultiplayerOptions & {
  initialState?: TShared;
};

export const useMultiplayerRoom = <TShared extends JsonRecord = JsonRecord>(
  config: UseMultiplayerRoomConfig<TShared>,
) => {
  const rules = JSON.stringify([config.tickRate, config.interest, config.limits, config.lobby]);
  const key = `${config.host}/${config.party}/${config.room}/${config.maxPlayers ?? ""}/${rules}/${config.offline === true}`;
  const [entry, setEntry] = useState<{ client: MultiplayerClient; key: string } | null>(null);
  let client = entry !== null && entry.key === key ? entry.client : null;

  if (client === null) {
    client = new MultiplayerClient({
      fallbackMs: config.fallbackMs,
      host: config.host,
      initialState: config.initialState,
      interest: config.interest,
      limits: config.limits,
      lobby: config.lobby,
      maxPlayers: config.maxPlayers,
      offline: config.offline,
      onClaim: config.onClaim,
      onEvent: config.onEvent,
      onTick: config.onTick,
      party: config.party,
      room: config.room,
      tickRate: config.tickRate,
    });
    setEntry({ client, key });
  }

  useEffect(
    () => () => {
      client.destroy();
    },
    [client],
  );

  const { onClaim, onEvent, onTick } = config;
  useEffect(() => {
    /* oxlint-disable react/immutability -- the client is a socket wrapper held in state only for its identity; reassigning its callback slots is the intended API */
    client.onEvent = onEvent;
    client.onClaim = onClaim;
    client.onTick = onTick;
    /* oxlint-enable react/immutability */
  }, [client, onClaim, onEvent, onTick]);

  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const updateSharedState = useCallback(
    (updater: Partial<TShared> | SharedUpdaterFn<TShared>) => {
      if (isSharedUpdaterFn(updater)) {
        client.updateSharedState((prev) => (updater as (p: TShared) => TShared)(prev as TShared));
      } else {
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
    (event: string, payload: JsonValue, options?: SendEventOptions) => {
      client.sendEvent(event, payload, options);
    },
    [client],
  );

  const sendToHost = useCallback(
    (event: string, payload: JsonValue) => {
      client.sendToHost(event, payload);
    },
    [client],
  );

  const goOffline = useCallback(() => {
    client.goOffline();
  }, [client]);

  const setRoomInfo = useCallback(
    (info: Partial<RoomInfo>) => {
      client.setRoomInfo(info);
    },
    [client],
  );

  return useMemo(
    () => ({
      ...snapshot,
      goOffline,
      sendEvent,
      sendToHost,
      setRoomInfo,
      sharedState: snapshot.sharedState as TShared,
      updateMyState,
      updateSharedState,
    }),
    [snapshot, updateSharedState, updateMyState, sendEvent, sendToHost, goOffline, setRoomInfo],
  );
};

const useRoom = <TShared extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
) => {
  if ("connectionStatus" in roomOrConfig) {
    return roomOrConfig;
  }

  // oxlint-disable-next-line react/hooks, react-hooks/rules-of-hooks -- the argument's shape is fixed per call site (a room or a config, never both over time), so this branch is stable across renders
  return useMultiplayerRoom<TShared>({
    ...roomOrConfig,
    initialState: initialState ?? roomOrConfig.initialState,
  });
};

export const useMultiplayerState = <TShared extends JsonRecord = JsonRecord>(
  roomOrConfig: MultiplayerRoom<TShared> | (MultiplayerOptions & { initialState?: TShared }),
  initialState?: TShared,
) => {
  const room = useRoom(roomOrConfig, initialState);
  const { hostId, playerId, updateSharedState } = room;
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
) => {
  const room = useRoom(roomOrConfig);
  const { playerId, updateMyState } = room;
  const seededForPlayer = useRef<string | null>(null);

  const playerState = useMemo(() => {
    const state =
      room.playerId !== null && room.playerId !== ""
        ? (room.players[room.playerId]?.state as TPlayerState | undefined)
        : undefined;

    return state ?? initialState ?? ({} as TPlayerState);
  }, [initialState, room.playerId, room.players]);

  useEffect(() => {
    if (
      initialState &&
      playerId !== null &&
      playerId !== "" &&
      seededForPlayer.current !== playerId
    ) {
      seededForPlayer.current = playerId;
      updateMyState((prev) => ({ ...initialState, ...prev }));
    }
  }, [playerId, updateMyState, initialState]);

  return useMemo(() => [playerState, room.updateMyState, room] as const, [playerState, room]);
};

export const useIsHost = (
  roomOrConfig: MultiplayerRoom | (MultiplayerOptions & { initialState?: JsonRecord }),
) => {
  const room = useRoom(roomOrConfig);

  return room.hostId !== null && room.hostId === room.playerId;
};
