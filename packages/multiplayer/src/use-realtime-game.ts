import { useCallback, useEffect, useRef, useState } from "react";

import type { MultiplayerGameConfig } from "./use-multiplayer-game";
import { useMultiplayerGame } from "./use-multiplayer-game";

export type Position = {
  x: number;
  y: number;
};

export type RealtimeGameConfig<
  TGameState = unknown,
  TPayload = unknown,
  TSettings = Record<string, unknown>,
> = {
  tickRate?: number; // Updates per second
  interpolation?: boolean; // Enable client-side interpolation
  autoTrackCursor?: boolean; // Automatically track mouse/touch movement
  throttleMs?: number; // Throttle position updates (default: based on tickRate)

  // Callbacks
  onGameTick?: (gameState: TGameState, deltaTime: number) => void;
  onPlayerAction?: (playerId: string, action: string, data: TPayload) => void;
  onGameStateChange?: (newState: TGameState) => void;
  onPlayerMoved?: (playerId: string, position: Position) => void;
  onPlayersSync?: (
    positions: Record<string, Position>,
    allPlayers?: Record<string, any>,
  ) => void;
} & Omit<
  MultiplayerGameConfig<TGameState, TPayload, TSettings>,
  "onGameEvent" | "onPlayerUpdated" | "onGameSync"
>;

export type GameEntity<TData = Record<string, unknown>> = {
  id: string;
  position?: Position;
  velocity?: Position;
  data?: TData;
  lastUpdate: number;
};

export function useRealtimeGame<
  TGameState = unknown,
  TPayload = unknown,
  TEntityData = Record<string, unknown>,
  TSettings = Record<string, unknown>,
>(config: RealtimeGameConfig<TGameState, TPayload, TSettings>) {
  const tickRate = config.tickRate ?? 60;
  const tickInterval = 1000 / tickRate;
  const interpolation = config.interpolation ?? true;
  const autoTrackCursor = config.autoTrackCursor ?? false;
  const throttleMs = config.throttleMs ?? tickInterval;

  const [entities, setEntities] = useState<
    Record<string, GameEntity<TEntityData>>
  >({});
  const [gameData, setGameData] = useState<TGameState>({} as TGameState);

  const lastTickRef = useRef<number>(Date.now());
  const lastUpdateRef = useRef<number>(0);
  const currentPositionRef = useRef<Position>({ x: 0, y: 0 });
  const gameLoopRef = useRef<number | null>(null);
  const entitiesRef = useRef(entities);
  const gameDataRef = useRef(gameData);

  entitiesRef.current = entities;
  gameDataRef.current = gameData;

  const game = useMultiplayerGame({
    ...config,
    onPlayerUpdated: (player) => {
      const position = (player.state as any)?.position as Position;
      if (position) {
        config.onPlayerMoved?.(player.id, position);
      }
    },
    onGameSync: (players, _gameState) => {
      const positions: Record<string, Position> = {};
      Object.entries(players).forEach(([id, player]) => {
        const position = (player.state as any)?.position as Position;
        if (position) {
          positions[id] = position;
        }
      });
      // Call onPlayersSync with positions and all players data
      config.onPlayersSync?.(positions, players);
    },
    onGameEvent: (event, payload, from) => {
      switch (event) {
        case "player_action":
          const actionPayload = payload as { action: string; data: TPayload };
          config.onPlayerAction?.(
            from!,
            actionPayload.action,
            actionPayload.data,
          );
          break;

        case "game_state_update":
          const updatePayload = payload as {
            entities?: Record<string, GameEntity<TEntityData>>;
            gameData?: Partial<TGameState>;
          };
          if (updatePayload.entities) {
            setEntities((prev: Record<string, GameEntity<TEntityData>>) => ({
              ...prev,
              ...updatePayload.entities,
            }));
          }
          if (updatePayload.gameData) {
            setGameData((prev: TGameState) => ({
              ...prev,
              ...updatePayload.gameData,
            }));
            config.onGameStateChange?.(updatePayload.gameData as TGameState);
          }
          break;

        case "entity_update":
          const entityPayload = payload as Partial<GameEntity<TEntityData>> & {
            id: string;
          };
          setEntities((prev) => ({
            ...prev,
            [entityPayload.id]: {
              ...prev[entityPayload.id],
              ...entityPayload,
              lastUpdate: Date.now(),
            },
          }));
          break;

        case "entity_remove":
          const removePayload = payload as { id: string };
          setEntities((prev: Record<string, GameEntity<TEntityData>>) => {
            const newEntities = { ...prev };
            delete newEntities[removePayload.id];
            return newEntities;
          });
          break;

        default:
          break;
      }
    },
  });

  // Game loop for client-side updates and interpolation
  useEffect(() => {
    const gameLoop = () => {
      const now = Date.now();
      const deltaTime = now - lastTickRef.current;

      if (deltaTime >= tickInterval) {
        // Run game tick
        config.onGameTick?.(gameDataRef.current, deltaTime);

        // Interpolate entities if enabled
        if (interpolation) {
          setEntities((prev: Record<string, GameEntity<TEntityData>>) => {
            const interpolated = { ...prev };
            Object.values(interpolated).forEach(
              (entity: GameEntity<TEntityData>) => {
                if (entity.velocity && entity.position) {
                  const timeSinceUpdate = now - entity.lastUpdate;
                  const factor = Math.min(timeSinceUpdate / tickInterval, 1);

                  entity.position.x += entity.velocity.x * factor;
                  entity.position.y += entity.velocity.y * factor;
                }
              },
            );
            return interpolated;
          });
        }

        lastTickRef.current = now;
      }

      gameLoopRef.current = requestAnimationFrame(gameLoop);
    };

    gameLoopRef.current = requestAnimationFrame(gameLoop);

    return () => {
      if (gameLoopRef.current) {
        cancelAnimationFrame(gameLoopRef.current);
      }
    };
  }, [tickInterval, interpolation, config]);

  // Set up automatic cursor tracking
  useEffect(() => {
    if (!autoTrackCursor) return;

    const handleMouseMove = (e: MouseEvent) => {
      updatePosition({ x: e.clientX, y: e.clientY }, "mouse");
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      if (touch) {
        updatePosition({ x: touch.clientX, y: touch.clientY }, "touch");
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("touchmove", handleTouchMove);
    };
  }, [autoTrackCursor]);

  // Position tracking methods
  const updatePosition = useCallback(
    (position: Position, pointer?: "mouse" | "touch") => {
      currentPositionRef.current = position;
      const now = Date.now();

      // Throttle updates
      if (now - lastUpdateRef.current < throttleMs) {
        return;
      }

      lastUpdateRef.current = now;

      game.updatePlayerGameState({
        position,
        pointer,
      });
    },
    [game, throttleMs],
  );

  const getPlayerPosition = useCallback(
    (playerId: string): Position | undefined => {
      const player = game.getPlayerById(playerId);
      return (player?.state as any)?.position as Position;
    },
    [game],
  );

  const getAllPlayerPositions = useCallback((): Record<string, Position> => {
    const positions: Record<string, Position> = {};
    Object.entries(game.players).forEach(([id, player]) => {
      const position = (player.state as any)?.position as Position;
      if (position) {
        positions[id] = position;
      }
    });
    return positions;
  }, [game.players]);

  const getCurrentPosition = useCallback((): Position => {
    return currentPositionRef.current;
  }, []);

  // Entity and action methods
  const sendAction = useCallback(
    (action: string, data: TPayload) => {
      game.sendGameAction("player_action", { action, data });
    },
    [game],
  );

  const updateEntity = useCallback(
    (entityId: string, updates: Partial<GameEntity<TEntityData>>) => {
      const update = {
        id: entityId,
        ...updates,
        lastUpdate: Date.now(),
      };

      game.sendGameAction("entity_update", update);

      // Update locally for immediate feedback
      setEntities((prev: Record<string, GameEntity<TEntityData>>) => ({
        ...prev,
        [entityId]: { ...prev[entityId], ...update },
      }));
    },
    [game],
  );

  const createEntity = useCallback(
    (
      entityId: string,
      entityData: Omit<GameEntity<TEntityData>, "id" | "lastUpdate">,
    ) => {
      const entity: GameEntity<TEntityData> = {
        id: entityId,
        ...entityData,
        lastUpdate: Date.now(),
      };

      game.sendGameAction("entity_create", entity);

      // Update locally for immediate feedback
      setEntities((prev) => ({
        ...prev,
        [entityId]: entity,
      }));
    },
    [game],
  );

  const removeEntity = useCallback(
    (entityId: string) => {
      game.sendGameAction("entity_remove", { id: entityId });

      // Update locally for immediate feedback
      setEntities((prev) => {
        const newEntities = { ...prev };
        delete newEntities[entityId];
        return newEntities;
      });
    },
    [game],
  );

  const updateGameData = useCallback(
    (updates: Partial<TGameState>) => {
      game.sendGameAction("game_data_update", updates);

      // Update locally for immediate feedback
      setGameData((prev: TGameState) => ({ ...prev, ...updates }));
    },
    [game],
  );

  const getEntity = useCallback(
    (entityId: string): GameEntity<TEntityData> | undefined => {
      return entitiesRef.current[entityId];
    },
    [],
  );

  const getEntitiesByType = useCallback(
    (type: string): GameEntity<TEntityData>[] => {
      return Object.values(entitiesRef.current).filter(
        (entity: GameEntity<TEntityData>) =>
          (entity.data as any)?.type === type,
      );
    },
    [],
  );

  const getPlayerEntity = useCallback(
    (playerId?: string): GameEntity<TEntityData> | undefined => {
      const id = playerId || game.playerId;
      if (!id) return undefined;
      return entitiesRef.current[id];
    },
    [game.playerId],
  );

  const getEntitiesInRadius = useCallback(
    (
      center: { x: number; y: number },
      radius: number,
    ): GameEntity<TEntityData>[] => {
      return Object.values(entitiesRef.current).filter(
        (entity: GameEntity<TEntityData>) => {
          if (!entity.position) return false;
          const dx = entity.position.x - center.x;
          const dy = entity.position.y - center.y;
          return Math.sqrt(dx * dx + dy * dy) <= radius;
        },
      );
    },
    [],
  );

  const resetGame = useCallback(() => {
    setEntities({});
    setGameData({} as TGameState);
    game.sendGameAction("reset_game", {});
  }, [game]);

  return {
    ...game,

    // Game state
    entities,
    gameData,

    // Position methods
    updatePosition,
    getPlayerPosition,
    getAllPlayerPositions,
    getCurrentPosition,

    // Entity management
    createEntity,
    updateEntity,
    removeEntity,
    getEntity,
    getEntitiesByType,
    getPlayerEntity,
    getEntitiesInRadius,

    // Game actions
    sendAction,
    updateGameData,
    resetGame,

    // Game configuration
    tickRate,
    interpolation,
    autoTrackCursor,
  };
}
