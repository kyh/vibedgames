"use client";

import Image from "next/image";
import { motion } from "motion/react";

import { useSandboxStore } from "@/components/chat/chat-state";
import { usePreviewStack } from "@/components/preview/preview-stack";
import { featuredGames } from "./data";
import { uiState } from "./ui-state";

export const DiscoverView = () => {
  const { setUrl } = useSandboxStore();
  const { setView } = uiState();
  const { setCurrentIndex, isMobile } = usePreviewStack();

  return (
    <motion.div
      className="flex gap-4 overflow-auto pb-4 md:flex-col-reverse"
      transition={{ type: "spring", bounce: 0.1 }}
      initial={{ opacity: 0, filter: "blur(5px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
    >
      {featuredGames.map((game, index) => (
        <button
          key={game.id}
          onMouseEnter={() => {
            setView("discover");
            setCurrentIndex(index);
          }}
          onClick={() => {
            if (isMobile) {
              setCurrentIndex(index);
              return;
            }
            setCurrentIndex(index);
            setView("play");
            setUrl(game.url, crypto.randomUUID());
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
