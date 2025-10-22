"use client";

import Image from "next/image";

import type { FeaturedGame } from "./data";
import { useSandboxStore } from "@/components/chat/state";
import { Preview as PreviewComponent } from "@/components/preview/preview";
import { PreviewStack } from "@/components/preview/preview-stack";
import { uiState } from "./composer";
import { featuredGames } from "./data";

export const Preview = () => {
  const { status } = useSandboxStore();
  const view = uiState((state) => state.view);

  const renderGameCard = (game: FeaturedGame) => (
    <PreviewComponent
      key={game.id}
      disabled={view === "discover" || status === "stopped"}
      url={game.url}
      preview={
        <Image
          src={game.preview}
          alt={game.name}
          fill
          className="rounded-xl object-cover shadow-lg"
        />
      }
    />
  );

  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      zoomed={view === "discover"}
    />
  );
};
