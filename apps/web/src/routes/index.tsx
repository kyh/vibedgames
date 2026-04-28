import { createFileRoute } from "@tanstack/react-router";

import { gameSearchSchema } from "@/components/game/data";
import { GameNavArrows } from "@/components/game/game-nav-arrows";
import { PlayView } from "@/components/game/play-view";
import { installResponse } from "@/lib/install-response";

const AI_BOT_UA =
  /(ClaudeBot|Claude-User|Anthropic-AI|GPTBot|ChatGPT-User|OAI-SearchBot|Cursor)/i;

export const Route = createFileRoute("/")({
  validateSearch: gameSearchSchema,
  server: {
    handlers: {
      GET: ({ request, next }) => {
        const ua = request.headers.get("user-agent") ?? "";
        if (AI_BOT_UA.test(ua)) return installResponse();
        return next();
      },
    },
  },
  component: PlayPage,
});

function PlayPage() {
  return (
    <>
      <header className="fixed bottom-16 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 md:w-96">
        <PlayView />
      </header>
      <GameNavArrows />
    </>
  );
}
