import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Canvas } from "@/components/canvas/canvas";
import { GameChrome } from "@/components/game/game-chrome";
import { Nav } from "@/components/game/nav";

const SiteLayout = () => (
  <GameChrome>
    <Canvas />
    <Outlet />
    <Nav />
  </GameChrome>
);

export const Route = createFileRoute("/_site")({
  component: SiteLayout,
});
