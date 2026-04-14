import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";

import { GameStack } from "@/components/canvas/game-stack";
import { Iframe } from "@/components/canvas/iframe";
import { Route } from "@/routes/index";
import { featuredGames } from "./data";

export const Canvas = () => {
  const { view, game } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  return (
    <div className="relative h-full w-full">
      <AnimatePresence>
        {view === "play" && (
          <motion.div
            key={game}
            className="absolute z-1 h-full w-full"
            initial={{ opacity: 0, filter: "blur(5px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(5px)" }}
            transition={{ duration: 0.2 }}
          >
            <Iframe url={game} />
          </motion.div>
        )}
      </AnimatePresence>
      <GameStack
        data={featuredGames}
        activeUrl={game}
        showStack={view === "discover"}
        onPreviewClick={(g) => {
          navigate({ search: { view: "play", game: g.url } });
        }}
      />
    </div>
  );
};
