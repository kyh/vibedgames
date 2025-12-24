"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ChatProvider } from "@/components/chat/chat-context";
import { useTRPC } from "@/trpc/react";
import { Composer } from "./_components/composer";
import { Preview } from "./_components/preview";
import { useUiStore } from "./_components/ui-store";

export const PageClient = () => {
  const params = useParams<{ gameId?: string[] }>();
  const trpc = useTRPC();
  const { setSandpackFiles } = useUiStore();
  const gameId = params.gameId?.[0];

  // Fetch build when gameId is present (this will use prefetched data if available)
  const getBuildQuery = trpc.game.getBuild.queryOptions(
    gameId ? { buildId: gameId } : { buildId: "" },
  );
  const { data: buildData } = useQuery({
    ...getBuildQuery,
    enabled: !!gameId,
  });

  // Load build files into store when build is fetched
  useEffect(() => {
    if (buildData?.build) {
      // Convert gameBuildFiles array to sandpackFiles format
      const files: Record<string, string> = {};
      for (const file of buildData.build.gameBuildFiles) {
        files[file.path] = file.content;
      }
      setSandpackFiles(files);
    }
  }, [buildData, setSandpackFiles]);

  return (
    <ChatProvider>
      <main className="h-dvh w-dvw overflow-hidden">
        <header className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 py-6 md:w-96">
          <Composer />
        </header>
        <Preview />
      </main>
    </ChatProvider>
  );
};
