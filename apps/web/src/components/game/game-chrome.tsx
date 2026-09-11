import { isGamePausedMessage, isGameStartedMessage, requestGamePause } from "@repo/embed/host";
import type { MessageData } from "@repo/embed/host";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { featuredGames, gameUrl } from "@/components/game/data";
import { useGameParam, usePathname } from "@/lib/use-game-param";

const GameChromeHiddenContext = createContext(false);

/** Whether the wrapper chrome is tucked away because a game is being played. */
export const useGameChromeHidden = () => useContext(GameChromeHiddenContext);

/**
 * Motion props for a piece of wrapper chrome that animates out of the way on
 * game start. `hiddenAt` is where the piece rests while hidden (defaults to
 * sliding down off the bottom edge). Includes `inert` so hidden chrome can't
 * be clicked or focused.
 */
const DEFAULT_HIDDEN_AT = { y: 96 };

export const gameChromeMotion = (hidden: boolean, hiddenAt?: { x?: number; y?: number }) => ({
  animate: hidden ? { ...(hiddenAt ?? DEFAULT_HIDDEN_AT), opacity: 0 } : { opacity: 1, x: 0, y: 0 },
  inert: hidden,
  initial: false as const,
  transition: { bounce: 0, duration: 0.6, type: "spring" as const },
});

interface GameChromeProps {
  children: React.ReactNode;
}

/**
 * Owns the played-game ↔ wrapper handshake: hides the chrome when the embedded
 * game announces it started and brings it back when the game pauses. Pausing
 * belongs to the game (Escape, or its own touch button); Escape with wrapper
 * focus is mirrored so the key works wherever focus landed.
 */
export const GameChrome = ({ children }: GameChromeProps) => {
  const pathname = usePathname();
  const game = useGameParam();
  const playing = pathname === "/";
  const [hidden, setHidden] = useState(false);
  const gameOrigins = useMemo(
    () => new Set(featuredGames.map((item) => new URL(gameUrl(item.slug)).origin)),
    [],
  );

  // Navigating to another game (or away from one) re-shows the chrome.
  const screen = `${pathname}:${game}`;
  const [shownFor, setShownFor] = useState(screen);
  if (shownFor !== screen) {
    setShownFor(screen);
    setHidden(false);
  }

  useEffect(() => {
    if (!playing) {
      return;
    }
    const handleMessage = (event: MessageEvent<MessageData>) => {
      const localDevGame =
        event.origin.startsWith("http://localhost:") ||
        event.origin.startsWith("http://127.0.0.1:");
      if (!localDevGame && !gameOrigins.has(event.origin)) {
        return;
      }
      if (isGameStartedMessage(event.data)) {
        setHidden(true);
      }
      // The game paused itself (Escape inside the iframe) — bring chrome back.
      if (isGamePausedMessage(event.data)) {
        setHidden(false);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [gameOrigins, playing]);

  const pause = useCallback(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[title='Game']");
    if (frame?.contentWindow) {
      requestGamePause(frame.contentWindow);
    }
    setHidden(false);
  }, []);

  // Escape with wrapper focus mirrors Escape inside the game: pause + chrome.
  useEffect(() => {
    if (!hidden) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        pause();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hidden, pause]);

  return (
    <GameChromeHiddenContext.Provider value={hidden}>{children}</GameChromeHiddenContext.Provider>
  );
};
