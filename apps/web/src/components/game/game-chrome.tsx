import { isGameStartedMessage, requestGamePause } from "@repo/embed/host";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

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
export const gameChromeMotion = (
  hidden: boolean,
  hiddenAt: { x?: number; y?: number } = { y: 96 },
) => ({
  initial: false as const,
  animate: hidden ? { ...hiddenAt, opacity: 0 } : { x: 0, y: 0, opacity: 1 },
  transition: { type: "spring" as const, bounce: 0, duration: 0.6 },
  inert: hidden,
});

type GameChromeProps = {
  children: React.ReactNode;
};

/**
 * Owns the played-game ↔ wrapper handshake: hides the chrome when the embedded
 * game announces it started, and shows a small pause button that asks the game
 * to pause and brings the chrome back.
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

  useEffect(() => {
    setHidden(false);
  }, [game, pathname]);

  useEffect(() => {
    if (!playing) return;
    const handleMessage = (event: MessageEvent<unknown>) => {
      const localDevGame =
        event.origin.startsWith("http://localhost:") ||
        event.origin.startsWith("http://127.0.0.1:");
      if (!localDevGame && !gameOrigins.has(event.origin)) return;
      if (isGameStartedMessage(event.data)) setHidden(true);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [gameOrigins, playing]);

  const pause = () => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[title='Game']");
    if (frame?.contentWindow) requestGamePause(frame.contentWindow);
    setHidden(false);
  };

  return (
    <GameChromeHiddenContext.Provider value={hidden}>
      {children}
      <AnimatePresence>
        {hidden && (
          <motion.button
            type="button"
            onClick={pause}
            aria-label="Pause game and show menu"
            className="text-muted-foreground hover:text-foreground fixed bottom-0 left-0 z-10 cursor-pointer px-4 py-6 font-mono text-xs transition-colors before:content-['['] after:content-[']']"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.35 } }}
            exit={{ opacity: 0, y: 12 }}
          >
            <span className="px-3 py-1.5">Pause</span>
          </motion.button>
        )}
      </AnimatePresence>
    </GameChromeHiddenContext.Provider>
  );
};
