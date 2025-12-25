"use client";

import type { FeaturedGame } from "./data";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { view, setView, gameId, setGameId } = useUiStore();

  const renderGameCard = (game: FeaturedGame) => {
    const disabled = view === "discover" || gameId !== game.gameId;

    return (
      <PreviewWeb
        key={game.gameId}
        disabled={disabled}
        preview={game.preview}
        name={game.name}
        onPreviewClick={() => {
          // Set gameId - it will auto-load files from featured games
          setGameId(game.gameId);
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
