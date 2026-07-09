import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Canvas } from "@/components/canvas/canvas";
import { GameChrome } from "@/components/game/game-chrome";
import { Nav } from "@/components/game/nav";

// Layout for the public game-facing pages (play, discover, build). Owns the
// game canvas background + bottom-left nav. Auth and admin sit outside this so
// they don't inherit the game chrome.
export const Route = createFileRoute("/_site")({
  component: SiteLayout,
});

function SiteLayout() {
  return (
    <GameChrome>
      <Canvas />
      <Outlet />
      <Nav />
    </GameChrome>
  );
}
