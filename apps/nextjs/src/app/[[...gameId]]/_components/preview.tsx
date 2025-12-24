"use client";

import type { FeaturedGame } from "./data";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { view, setView, currentIndex, setCurrentIndex, reset } = useUiStore();

  const renderGameCard = (game: FeaturedGame) => {
    const gameIndex = featuredGames.findIndex((g) => g.id === game.id);
    const disabled = view === "discover" || currentIndex !== gameIndex;

    return (
      <PreviewWeb
        key={game.id}
        disabled={disabled}
        preview={game.preview}
        name={game.name}
        onPreviewClick={() => {
          // Clear any loaded build files when selecting a game
          reset();
          setCurrentIndex(gameIndex);
          setView("play");
        }}
      />
    );
  };

  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      showStack={view === "discover"}
    />
  );
};
