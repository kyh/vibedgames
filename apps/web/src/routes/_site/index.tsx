import { createFileRoute } from "@tanstack/react-router";

import { motion } from "motion/react";

import { gameSearchSchema } from "@/components/game/data";
import { gameChromeMotion, useGameChromeHidden } from "@/components/game/game-chrome";
import { PlayView } from "@/components/game/play-view";
import { installResponse } from "@/lib/install-response";

const AI_BOT_UA = /(ClaudeBot|Claude-User|Claude-SearchBot|GPTBot|ChatGPT-User|OAI-SearchBot)/i;

export const Route = createFileRoute("/_site/")({
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
  const gameChromeHidden = useGameChromeHidden();

  return (
    <motion.header
      {...gameChromeMotion(gameChromeHidden)}
      className="fixed bottom-16 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 sm:w-96"
    >
      <PlayView />
    </motion.header>
  );
}
