import { createFileRoute } from "@tanstack/react-router";

import { motion } from "motion/react";

import { gameSearchSchema } from "@/components/game/data";
import { gameChromeMotion, useGameChromeHidden } from "@/components/game/game-chrome";
import { PlayView } from "@/components/game/play-view";
import { TextFallback } from "@/components/site/text-fallback";
import { homeDoc } from "@/content/home";
import {
  MARKDOWN,
  markdownResponse,
  negotiate,
  notAcceptableResponse,
  VARY,
} from "@/lib/content-negotiation";
import { docToMarkdown } from "@/lib/doc";
import { docHead, varyHeaders } from "@/lib/doc-route";
import { installResponse } from "@/lib/install-response";

const AI_BOT_UA = /(ClaudeBot|Claude-User|Claude-SearchBot|GPTBot|ChatGPT-User|OAI-SearchBot)/i;

/** `/` also branches on User-Agent, so its cache key has to include it. */
const HOME_VARY = `${VARY}, User-Agent`;

export const Route = createFileRoute("/_site/")({
  validateSearch: gameSearchSchema,
  server: {
    handlers: {
      GET: ({ request, next }) => {
        const negotiation = negotiate(request.headers.get("accept"));
        if (negotiation.kind === "not-acceptable") return notAcceptableResponse(request);

        // Named AI crawlers get the install instructions rather than the page
        // text: for them the useful answer to "what is this site" is the
        // command that installs it.
        const ua = request.headers.get("user-agent") ?? "";
        if (AI_BOT_UA.test(ua)) return installResponse({ headers: { Vary: HOME_VARY } });

        if (negotiation.kind === "match" && negotiation.type === MARKDOWN) {
          return markdownResponse(docToMarkdown(homeDoc), { headers: { Vary: HOME_VARY } });
        }

        return next();
      },
    },
  },
  headers: varyHeaders(HOME_VARY),
  head: () => docHead(homeDoc),
  component: PlayPage,
});

function PlayPage() {
  const gameChromeHidden = useGameChromeHidden();

  return (
    <>
      <TextFallback
        doc={homeDoc}
        note="This page normally embeds a playable game, which needs JavaScript. Everything below works without it."
      />
      <motion.header
        {...gameChromeMotion(gameChromeHidden)}
        className="fixed bottom-16 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 sm:w-96"
      >
        <PlayView />
      </motion.header>
    </>
  );
}
