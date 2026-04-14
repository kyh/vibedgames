import { useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";

import { GameStack } from "@/components/canvas/game-stack";
import { Iframe } from "@/components/canvas/iframe";
import { Route } from "@/routes/index";
import { featuredGames } from "./data";

export const Canvas = () => {
  const { view, game } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const shouldShowIframe = view !== "discover";

  return (
    <div className="relative h-full w-full">
      <motion.div
        className="absolute z-1 h-full w-full"
        variants={{
          hidden: { opacity: 0, filter: "blur(5px)" },
          visible: { opacity: 1, filter: "blur(0px)" },
        }}
        animate={shouldShowIframe ? "visible" : "hidden"}
        transition={{ duration: 0.2 }}
      >
        <Iframe url={game} />
      </motion.div>
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
