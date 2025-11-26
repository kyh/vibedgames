"use client";

import type { FeaturedGame } from "./data";
import { useSandboxStore } from "@/components/chat/sandbox-store";
import { useSandpackStore } from "@/components/sandpack/sandpack-store";
import { SandpackPreview } from "@/components/sandpack/sandpack-preview";
import { PreviewStack } from "@/components/preview/preview-stack";
import { PreviewWeb } from "@/components/preview/preview-web";
import { featuredGames } from "./data";
import { useUiStore } from "./ui-store";

export const Preview = () => {
  const { url, setUrl } = useSandboxStore();
  const { generatedFiles } = useSandpackStore();
  const { view, setView } = useUiStore();

  // Show sandpack preview when building (has generated files)
  const showSandpackPreview = view === "build" && generatedFiles.size > 0;

  const renderGameCard = (game: FeaturedGame) => {
    const disabled =
      view === "discover" || url !== game.url;
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

  // In build mode with generated files, show sandpack preview
  if (showSandpackPreview) {
    return (
      <div className="relative h-full w-full overflow-clip rounded-xl shadow-lg">
        <SandpackPreview />
      </div>
    );
  }

  // Otherwise show the featured games stack
  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      showStack={view === "discover"}
    />
  );
};
