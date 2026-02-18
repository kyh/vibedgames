"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ChatProvider } from "@/components/chat/chat-context";
import { useTRPC } from "@/trpc/react";
import { Canvas } from "./_components/canvas";
import { Composer } from "./_components/composer";
import { useUiStore } from "./_components/ui-store";

export const PageClient = () => {
  const params = useParams<{ gameId?: string[] }>();
  const trpc = useTRPC();
  const { setGameId } = useUiStore();
  const gameId = params.gameId?.[0];

  // Fetch build when gameId is present (this will use prefetched data if available)
  const getBuildQuery = trpc.localGame.getBuild.queryOptions(
    gameId ? { buildId: gameId } : { buildId: "" },
  );
  const { data: buildData } = useQuery({
    ...getBuildQuery,
    enabled: !!gameId,
  });

  // Set gameId when build is fetched
  useEffect(() => {
    if (gameId && buildData?.build) {
      setGameId(gameId);
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
