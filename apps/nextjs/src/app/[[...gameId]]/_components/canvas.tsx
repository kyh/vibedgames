"use client";

import { Activity } from "react";

import { GameStack } from "@/components/canvas/game-stack";
import { Iframe } from "@/components/canvas/iframe";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Canvas = () => {
  const { view, setView, setGameId, gameId, isLocalGame } = useUiStore();
  const shouldShowIframe = view !== "discover";

  return (
    <div className="relative h-full w-full">
      <Activity mode={shouldShowIframe ? "visible" : "hidden"}>
        <Iframe
          className="absolute inset-0"
          url={isLocalGame ? undefined : gameId}
        />
      </Activity>
      <GameStack
        data={featuredGames}
        showStack={view === "discover"}
        onPreviewClick={(game) => {
          setGameId(game.url);
          setView("play");
        }}
      />
    </div>
  );
};
