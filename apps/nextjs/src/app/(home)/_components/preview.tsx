"use client";

import type { FeaturedGame } from "./data";
import { useWorkspaceStore } from "@/components/chat/workspace-store";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { previewUrl, setPreviewUrl } = useWorkspaceStore();
  const { view, setView } = useUiStore();

  const renderGameCard = (game: FeaturedGame) => {
    const disabled = view === "discover" || previewUrl !== game.url;
    return (
      <PreviewWeb
        key={game.id}
        disabled={disabled}
        url={game.url}
        preview={game.preview}
        name={game.name}
        onPreviewClick={() => {
          setView("play");
          setPreviewUrl(game.url, crypto.randomUUID());
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
