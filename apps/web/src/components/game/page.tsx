import { useState } from "react";

import { featuredGames } from "./data";
import { Canvas } from "./canvas";
import { Composer } from "./composer";
import { GameNavArrows } from "./game-nav-arrows";

export const PageClient = () => {
  const [previewUrl, setPreviewUrl] = useState(featuredGames[0]?.url ?? "");

  return (
    <main className="h-dvh w-dvw overflow-hidden">
      <header className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 py-6 md:w-96">
        <Composer onHover={setPreviewUrl} />
      </header>
      <Canvas previewUrl={previewUrl} />
      <GameNavArrows />
    </main>
  );
};
