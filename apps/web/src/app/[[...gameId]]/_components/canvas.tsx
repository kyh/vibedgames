"use client";

import { motion } from "motion/react";

import { GameStack } from "@/components/canvas/game-stack";
import { Iframe } from "@/components/canvas/iframe";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Canvas = () => {
  const { view, setView, setGameId, gameId, isLocalGame } = useUiStore();
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
        <Iframe url={isLocalGame ? undefined : gameId} />
      </motion.div>
      <GameStack
        data={featuredGames}
        showStack={view === "discover"}
        onPreviewClick={(game) => {
          setGameId(game.url);
          setView("play");
        }}
      />
    </div>
  );
};
