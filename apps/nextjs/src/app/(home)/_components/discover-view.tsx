"use client";

import Image from "next/image";
import { motion } from "framer-motion";

import { useSandboxStore } from "@/components/chat/state";
import { usePreviewStack } from "@/components/preview/preview-stack";
import { uiState } from "./composer";
import { featuredGames } from "./data";

export const DiscoverView = () => {
  const { setUrl } = useSandboxStore();
  const { setView } = uiState();
  const { setCurrentIndex } = usePreviewStack();

  return (
    <div className="flex flex-col-reverse gap-4 pb-4">
      {featuredGames.map((game, index) => (
        <motion.button
          key={game.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{
            duration: 0.5,
            delay: index * 0.1,
            ease: "easeOut",
          }}
          onMouseEnter={() => {
            setView("discover");
            setCurrentIndex(index);
          }}
          onClick={() => {
            setView("play");
            setCurrentIndex(index);
            setUrl(game.url, crypto.randomUUID());
          }}
          className="hover:border-foreground relative aspect-video w-30 overflow-clip rounded-lg border border-transparent transition-colors"
        >
          <Image
            src={game.preview}
            alt={game.name}
            fill
            className="object-cover"
          />
        </motion.button>
      ))}
    </div>
  );
};
