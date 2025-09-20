import { useCallback, useContext, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import { MultiplayerContext } from "./context";
import type {
  MultiplayerConnectionStatus,
  PlayerMap,
  PlayerState,
  SharedState,
} from "./types";

type ContextShape<TShared, TPlayer> = {
  socket: WebSocket | null;
  selfId: string | null;
  hostId: string | null;
  players: PlayerMap<TPlayer>;
  sharedState: TShared;
  status: MultiplayerConnectionStatus;
  setSharedState: Dispatch<SetStateAction<TShared>>;
  setPlayerState: (updater: SetStateAction<TPlayer>, playerId?: string) => void;
  getPlayerState: (playerId: string) => TPlayer | undefined;
};

function useMultiplayerContext<TShared, TPlayer>() {
  const context = useContext(MultiplayerContext);
  if (!context) {
    throw new Error("useMultiplayer hooks must be used within a MultiplayerProvider");
  }

  return context as unknown as ContextShape<TShared, TPlayer>;
}

export function useMultiplayerState<TShared extends SharedState>() {
  const context = useMultiplayerContext<TShared, PlayerState>();

  return useMemo(
    () => [context.sharedState, context.setSharedState] as const,
    [context.setSharedState, context.sharedState],
  );
}

export function usePlayerState<TPlayer extends PlayerState>(playerId?: string) {
  const context = useMultiplayerContext<SharedState, TPlayer>();
  const targetId = playerId ?? context.selfId ?? undefined;
  const playerEntry = targetId ? context.players[targetId] : undefined;

  const fallbackStateRef = useRef<TPlayer | null>(null);
  fallbackStateRef.current ??= {} as TPlayer;

  const resolvedState = playerEntry?.state ?? fallbackStateRef.current;

  const setState = useCallback(
    (updater: SetStateAction<TPlayer>) => {
      if (!targetId) return;
      if (playerId && playerId !== context.selfId) return;
      context.setPlayerState(updater, targetId);
    },
    [context, playerId, targetId],
  );

  return useMemo(
    () => [resolvedState, setState, playerEntry] as const,
    [playerEntry, resolvedState, setState],
  );
}

export function usePlayers<TPlayer extends PlayerState>() {
  const context = useMultiplayerContext<SharedState, TPlayer>();

  return useMemo(() => Object.values(context.players), [context.players]);
}

export function useIsHost() {
  const context = useMultiplayerContext<SharedState, PlayerState>();
  return context.selfId != null && context.selfId === context.hostId;
}

export function useSelf<TPlayer extends PlayerState>() {
  const context = useMultiplayerContext<SharedState, TPlayer>();
  return context.selfId ? context.players[context.selfId] : undefined;
}

export function useConnectionStatus() {
  const context = useMultiplayerContext<SharedState, PlayerState>();
  return context.status;
}
