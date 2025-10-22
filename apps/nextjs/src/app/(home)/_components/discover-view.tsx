"use client";

import Image from "next/image";

import { useSandboxStore } from "@/components/chat/state";
import { usePreviewStack } from "@/components/preview/preview-stack";
import { uiState } from "./composer";
import { featuredGames } from "./data";

export const DiscoverView = () => {
  const { setUrl } = useSandboxStore();
  const { setView } = uiState();
  const { setCurrentIndex } = usePreviewStack();

  return (
    <div className="flex gap-2">
      {featuredGames.map((game, index) => (
        <button
          key={game.id}
          onMouseEnter={() => {
            setView("discover");
            setCurrentIndex(index);
          }}
          onClick={() => {
            setView("play");
            setCurrentIndex(index);
            setUrl(game.url, crypto.randomUUID());
          }}
          className="hover:border-foreground border border-transparent transition-colors"
        >
          <div className="relative h-[110px] w-[90px] overflow-hidden">
            <Image
              src={game.preview}
              alt={game.name}
              fill
              className="object-cover"
            />
          </div>
        </button>
      ))}
    </div>
  );
};
