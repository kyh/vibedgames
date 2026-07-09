import { createFileRoute, Outlet } from "@tanstack/react-router";
import { isGameStartedMessage } from "@vibedgames/multiplayer";
import { useEffect, useMemo, useState } from "react";

import { Canvas } from "@/components/canvas/canvas";
import { featuredGames, gameUrl } from "@/components/game/data";
import { GameChromeProvider } from "@/components/game/game-chrome";
import { Nav } from "@/components/game/nav";
import { useGameParam, usePathname } from "@/lib/use-game-param";

// Layout for the public game-facing pages (play, discover, build). Owns the
// game canvas background + bottom-left nav. Auth and admin sit outside this so
// they don't inherit the game chrome.
export const Route = createFileRoute("/_site")({
  component: SiteLayout,
});

function SiteLayout() {
  const pathname = usePathname();
  const game = useGameParam();
  const [gameChromeHidden, setGameChromeHidden] = useState(false);
  const gameOrigins = useMemo(
    () => new Set(featuredGames.map((item) => new URL(gameUrl(item.slug)).origin)),
    [],
  );

  useEffect(() => {
    setGameChromeHidden(false);
  }, [game, pathname]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (pathname !== "/") return;
      const localDevGame =
        event.origin.startsWith("http://localhost:") ||
        event.origin.startsWith("http://127.0.0.1:");
      if (!localDevGame && !gameOrigins.has(event.origin)) return;
      if (isGameStartedMessage(event.data)) setGameChromeHidden(true);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [gameOrigins, pathname]);

  return (
    <GameChromeProvider hidden={gameChromeHidden}>
      <Canvas />
      <Outlet />
      {!gameChromeHidden && <Nav />}
    </GameChromeProvider>
  );
}
