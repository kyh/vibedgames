"use client";

import type { FeaturedGame } from "./data";
import { useSandboxStore } from "@/components/chat/sandbox-store";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { PreviewSandpack } from "@/components/preview/preview-sandpack";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { status, url, setUrl, sandpackFiles } = useSandboxStore();
  const { view, setView } = useUiStore();

  const renderGameCard = (game: FeaturedGame) => {
    const disabled =
      view === "discover" || status === "stopped" || url !== game.url;
    return (
      <PreviewWeb
        key={game.id}
        disabled={disabled}
        url={game.url}
        preview={game.preview}
        name={game.name}
        onPreviewClick={() => {
          setView("play");
          setUrl(game.url, crypto.randomUUID());
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
