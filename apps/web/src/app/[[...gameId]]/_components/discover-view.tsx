"use client";

import Image from "next/image";
import { motion } from "motion/react";

import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const DiscoverView = () => {
  const { setView, setGameId } = useUiStore();

  return (
    <motion.div
      className="flex gap-4 overflow-auto pb-4 md:flex-col-reverse"
      transition={{ type: "spring", bounce: 0.1 }}
      initial={{ opacity: 0, filter: "blur(5px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
    >
      {featuredGames.map((game) => (
        <button
          key={game.url}
          onMouseEnter={() => {
            setGameId(game.url);
            setView("discover");
          }}
          onClick={() => {
            setGameId(game.url);
            setView("play");
          }}
          className="hover:border-foreground relative aspect-video w-30 shrink-0 overflow-clip rounded-lg border border-transparent transition-colors"
        >
          <Image
            src={game.preview}
            alt={game.name}
            fill
            className="object-cover"
          />
        </button>
      ))}
    </motion.div>
  );
};
