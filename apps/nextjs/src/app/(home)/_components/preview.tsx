"use client";

import type { FeaturedGame } from "./data";
import { useSandpackStore } from "@/components/chat/sandbox-store";
import { PreviewSandpack } from "@/components/preview/preview-sandpack";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { sandpackFiles } = useSandpackStore();
  const { view, setView, currentIndex, setCurrentIndex } = useUiStore();

  const renderGameCard = (game: FeaturedGame) => {
    const gameIndex = featuredGames.findIndex((g) => g.id === game.id);
    const disabled = view === "discover" || currentIndex !== gameIndex;
    return (
      <PreviewWeb
        key={game.id}
        disabled={disabled}
        url={game.url}
        preview={game.preview}
        name={game.name}
        onPreviewClick={() => {
          setCurrentIndex(gameIndex);
          setView("play");
        }}
      />
    );
  };

  if (view === "build") {
    return <PreviewSandpack files={sandpackFiles} />;
  }

  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      showStack={view === "discover"}
    />
  );
};
