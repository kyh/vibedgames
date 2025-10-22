"use client";

import Image from "next/image";

import type { FeaturedGame } from "./data";
import { useSandboxStore } from "@/components/chat/state";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { uiState } from "./composer";
import { featuredGames } from "./data";

export const Preview = () => {
  const { status, url, setUrl } = useSandboxStore();
  const { view, setView } = uiState();

  const renderGameCard = (game: FeaturedGame) => (
    <PreviewWeb
      key={game.id}
      disabled={view === "discover" || status === "stopped" || url !== game.url}
      url={game.url}
      renderThumbnail={() => (
        <button
          className="absolute inset-0 overflow-clip rounded-xl shadow-lg"
          onClick={() => {
            setView("play");
            setUrl(game.url, crypto.randomUUID());
          }}
        >
          <Image
            className="object-cover"
            src={game.preview}
            alt={game.name}
            fill
          />
        </button>
      )}
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
