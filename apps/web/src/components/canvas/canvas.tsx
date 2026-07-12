import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useWebHaptics } from "web-haptics/react";

import { featuredGames, gameUrl } from "@/components/game/data";
import { useGameParam, usePathname } from "@/lib/use-game-param";
import { GameStack } from "./game-stack";
import { Iframe } from "./iframe";

export const Canvas = () => {
  const navigate = useNavigate();
  const { trigger } = useWebHaptics();
  const pathname = usePathname();
  const game = useGameParam() ?? featuredGames[0]?.slug ?? "";
  const isPlay = pathname === "/";
  const isDiscover = pathname === "/discover";

  return (
    <>
      <div className="fixed inset-0 z-0">
        <GameStack
          data={featuredGames}
          activeSlug={game}
          showStack={isDiscover}
          onPreviewClick={(g) => {
            trigger("selection");
            void navigate({ to: "/", search: { game: g.slug } });
          }}
          onSwipe={(g) => {
            trigger("selection");
            void navigate({ to: "/discover", search: { game: g.slug }, replace: true });
          }}
        />
      </div>
      <AnimatePresence>
        {isPlay && (
          <motion.div
            key={game}
            className="fixed inset-0 z-1"
            initial={{ opacity: 0, filter: "blur(5px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(5px)" }}
            transition={{ duration: 0.2 }}
          >
            <Iframe url={gameUrl(game)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
