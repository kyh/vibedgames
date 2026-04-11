import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ChatProvider } from "@/components/chat/chat-context";
import { useTRPC } from "@/lib/trpc";
import { Canvas } from "./canvas";
import { Composer } from "./composer";
import { toSandpack } from "./sandpack";
import { useUiStore } from "./ui-store";

export const PageClient = () => {
  const params = useParams({ strict: false }) as { gameId?: string };
  const trpc = useTRPC();
  const { setGameId } = useUiStore();
  const gameId = params.gameId;

  // Fetch build when gameId is present (this will use prefetched data if available)
  const getBuildQuery = trpc.localGame.getBuild.queryOptions(
    gameId ? { buildId: gameId } : { buildId: "" },
  );
  const { data: buildData } = useQuery({
    ...getBuildQuery,
    enabled: !!gameId,
  });

  // Set gameId and load build files when build is fetched
  useEffect(() => {
    if (gameId && buildData?.build) {
      setGameId(gameId, toSandpack(buildData.build.gameBuildFiles));
    }
  }, [buildData, gameId, setGameId]);

  return (
    <ChatProvider>
      <main className="h-dvh w-dvw overflow-hidden">
        <header className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 py-6 md:w-96">
          <Composer />
        </header>
        <Canvas />
      </main>
    </ChatProvider>
  );
};
