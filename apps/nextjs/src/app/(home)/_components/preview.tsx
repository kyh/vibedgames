"use client";

import Image from "next/image";

import type { FeaturedGame } from "./data";
import { useSandboxStore } from "@/components/chat/sandbox-state";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-state";

export const Preview = () => {
  const { status, url, setUrl } = useSandboxStore();
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

  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      showStack={view === "discover"}
    />
  );
};
