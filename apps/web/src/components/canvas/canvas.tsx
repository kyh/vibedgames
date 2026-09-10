import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useWebHaptics } from "web-haptics/react";

import { featuredGames, gameUrl } from "@/components/game/data";
import { useGameParam, usePathname } from "@/lib/use-game-param";
import { GameStack } from "./game-stack";
import { Iframe } from "./iframe";

const deckMode = (isDiscover: boolean, isPlay: boolean) => {
  if (isDiscover) {
    return "stack";
  }
  if (isPlay) {
    return "zoom";
  }
  return "hidden";
};

export const Canvas = () => {
  const navigate = useNavigate();
  const { trigger } = useWebHaptics();
  const pathname = usePathname();
  const game = useGameParam() ?? featuredGames[0]?.slug ?? "";
  const isPlay = pathname === "/";
  const isDiscover = pathname === "/discover";

  // The zoom hand-off only makes sense between discover and play, where the iframe lands on
  // top of the card. Anywhere else (build, auth, ...) the deck just fades out.
  const mode = deckMode(isDiscover, isPlay);

  return (
    <>
      <div className="fixed inset-0 z-0">
        <GameStack
          data={featuredGames}
          activeSlug={game}
          mode={mode}
          onPreviewClick={(g) => {
            trigger("selection");
            void navigate({ search: { game: g.slug }, to: "/" });
          }}
          onSwipe={(g) => {
            trigger("selection");
            void navigate({ replace: true, search: { game: g.slug }, to: "/discover" });
          }}
        />
      </div>
      <AnimatePresence>
        {isPlay && (
          <motion.div
            key={game}
            className="fixed inset-0 z-1"
            initial={{ filter: "blur(5px)", opacity: 0 }}
            animate={{ filter: "blur(0px)", opacity: 1 }}
            exit={{ filter: "blur(5px)", opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Iframe url={gameUrl(game)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
