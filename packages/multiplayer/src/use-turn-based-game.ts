import { useCallback, useEffect, useState } from "react";

import type { MultiplayerGameConfig } from "./use-multiplayer-game";
import { useMultiplayerGame } from "./use-multiplayer-game";

export type TurnBasedGameState = {
  currentTurn: string | null;
  turnOrder: string[];
  turnCount: number;
  gamePhase: "waiting" | "playing" | "ended";
  winner?: string;
};

export type TurnBasedGameConfig<TGameState = unknown, TMove = unknown, TSettings = Record<string, unknown>> = {
  minPlayers?: number;
  maxPlayers?: number;
  turnTimeLimit?: number; // in milliseconds
  onTurnChanged?: (currentPlayer: string, turnCount: number) => void;
  onGameStarted?: (turnOrder: string[]) => void;
  onGameEnded?: (winner?: string) => void;
  onTurnTimeUp?: (currentPlayer: string) => void;
  onPlayerMove?: (playerId: string, move: TMove) => void;
} & Omit<MultiplayerGameConfig<TGameState, TMove, TSettings>, "onGameSync" | "onGameEvent">;

export function useTurnBasedGame<TGameState = unknown, TMove = unknown, TSettings = Record<string, unknown>>(
  config: TurnBasedGameConfig<TGameState, TMove, TSettings>
) {
  const [turnState, setTurnState] = useState<TurnBasedGameState>({
    currentTurn: null,
    turnOrder: [],
    turnCount: 0,
    gamePhase: "waiting",
  });

  const [turnTimer, setTurnTimer] = useState<number | null>(null);

  const game = useMultiplayerGame({
    ...config,
    gameConfig: {
      ...config.gameConfig,
      maxPlayers: config.maxPlayers,
      gameType: "turn-based",
      customSettings: {
        ...config.gameConfig?.customSettings,
        minPlayers: config.minPlayers ?? 2,
        turnTimeLimit: config.turnTimeLimit,
      },
    },
    onGameSync: (_players, gameState) => {
      if (gameState && (gameState as any).turnState) {
        setTurnState((gameState as any).turnState as TurnBasedGameState);
      }
    },
    onGameEvent: (event, payload, from) => {
      switch (event) {
        case "turn_changed":
          const turnPayload = payload as { currentPlayer: string; turnCount: number };
          setTurnState((prev) => ({
            ...prev,
            currentTurn: turnPayload.currentPlayer,
            turnCount: turnPayload.turnCount,
          }));
          config.onTurnChanged?.(turnPayload.currentPlayer, turnPayload.turnCount);
          break;

        case "game_started":
          const startPayload = payload as { turnOrder: string[]; firstPlayer: string };
          setTurnState((prev) => ({
            ...prev,
            gamePhase: "playing",
            turnOrder: startPayload.turnOrder,
            currentTurn: startPayload.firstPlayer,
            turnCount: 1,
          }));
          config.onGameStarted?.(startPayload.turnOrder);
          break;

        case "game_ended":
          const endPayload = payload as { winner?: string };
          setTurnState((prev) => ({
            ...prev,
            gamePhase: "ended",
            winner: endPayload.winner,
          }));
          config.onGameEnded?.(endPayload.winner);
          break;

        case "turn_time_up":
          const timePayload = payload as { currentPlayer: string };
          config.onTurnTimeUp?.(timePayload.currentPlayer);
          break;

        case "player_move":
          config.onPlayerMove?.(from!, payload as TMove);
          break;

        default:
          break;
      }
    },
  });

  // Start turn timer when it's player's turn
  useEffect(() => {
    if (turnState.currentTurn === game.playerId && config.turnTimeLimit) {
      const timer = window.setTimeout(() => {
        config.onTurnTimeUp?.(game.playerId!);
        // Auto-skip turn if time runs out
        skipTurn();
      }, config.turnTimeLimit);

      setTurnTimer(timer);

      return () => {
        window.clearTimeout(timer);
        setTurnTimer(null);
      };
    }
  }, [turnState.currentTurn, game.playerId, config.turnTimeLimit]);

  const startGame = useCallback(() => {
    if (game.getPlayerCount() < (config.minPlayers ?? 2)) {
      console.warn("Not enough players to start game");
      return;
    }

    game.sendGameAction("start_game", {});
  }, [game, config.minPlayers]);

  const makeMove = useCallback(
    (move: TMove) => {
      if (turnState.currentTurn !== game.playerId) {
        console.warn("It's not your turn");
        return;
      }

      game.sendGameAction("player_move", move);
    },
    [game, turnState.currentTurn],
  );

  const endTurn = useCallback(() => {
    if (turnState.currentTurn !== game.playerId) {
      console.warn("It's not your turn");
      return;
    }

    game.sendGameAction("end_turn", {});

    // Clear turn timer
    if (turnTimer) {
      window.clearTimeout(turnTimer);
      setTurnTimer(null);
    }
  }, [game, turnState.currentTurn, turnTimer]);

  const skipTurn = useCallback(() => {
    if (turnState.currentTurn !== game.playerId) {
      console.warn("It's not your turn");
      return;
    }

    game.sendGameAction("skip_turn", {});

    // Clear turn timer
    if (turnTimer) {
      window.clearTimeout(turnTimer);
      setTurnTimer(null);
    }
  }, [game, turnState.currentTurn, turnTimer]);

  const endGame = useCallback(
    (winner?: string) => {
      game.sendGameAction("end_game", { winner });
    },
    [game],
  );

  const restartGame = useCallback(() => {
    game.sendGameAction("restart_game", {});
    setTurnState({
      currentTurn: null,
      turnOrder: [],
      turnCount: 0,
      gamePhase: "waiting",
    });
  }, [game]);

  const isMyTurn = useCallback((): boolean => {
    return turnState.currentTurn === game.playerId;
  }, [turnState.currentTurn, game.playerId]);

  const getNextPlayer = useCallback((): string | null => {
    if (!turnState.currentTurn || turnState.turnOrder.length === 0) {
      return null;
    }

    const currentIndex = turnState.turnOrder.indexOf(turnState.currentTurn);
    const nextIndex = (currentIndex + 1) % turnState.turnOrder.length;
    return turnState.turnOrder[nextIndex] || null;
  }, [turnState]);

  const getPreviousPlayer = useCallback((): string | null => {
    if (!turnState.currentTurn || turnState.turnOrder.length === 0) {
      return null;
    }

    const currentIndex = turnState.turnOrder.indexOf(turnState.currentTurn);
    const prevIndex =
      currentIndex === 0 ? turnState.turnOrder.length - 1 : currentIndex - 1;
    return turnState.turnOrder[prevIndex] || null;
  }, [turnState]);

  const getTurnTimeRemaining = useCallback((): number | null => {
    if (!turnTimer || !config.turnTimeLimit) {
      return null;
    }

    // This is a rough estimate - for precise timing, you'd need to track when the turn started
    return config.turnTimeLimit;
  }, [turnTimer, config.turnTimeLimit]);

  return {
    ...game,

    // Turn-based state
    ...turnState,

    // Turn-based actions
    startGame,
    makeMove,
    endTurn,
    skipTurn,
    endGame,
    restartGame,

    // Turn-based utilities
    isMyTurn,
    getNextPlayer,
    getPreviousPlayer,
    getTurnTimeRemaining,
  };
}
