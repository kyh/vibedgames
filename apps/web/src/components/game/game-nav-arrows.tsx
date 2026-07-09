import { useNavigate } from "@tanstack/react-router";
import { Button } from "@repo/ui/components/button";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { motion } from "motion/react";

import { gameChromeMotion, useGameChromeHidden } from "@/components/game/game-chrome";
import { Route } from "@/routes/_site/index";
import { featuredGames } from "./data";

export const GameNavArrows = () => {
  const { game } = Route.useSearch();
  const hidden = useGameChromeHidden();
  const navigate = useNavigate({ from: "/" });

  const currentIndex = featuredGames.findIndex((g) => g.slug === game);
  const len = featuredGames.length;

  const goTo = (index: number) => {
    const target = featuredGames[((index % len) + len) % len];
    if (target) {
      navigate({ search: { game: target.slug } });
    }
  };

  if (currentIndex === -1) return null;

  return (
    <motion.div
      {...gameChromeMotion(hidden, { x: 64 })}
      className="fixed right-4 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-1 sm:flex"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={() => goTo(currentIndex - 1)}
        aria-label="Previous game"
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => goTo(currentIndex + 1)}
        aria-label="Next game"
      >
        <ChevronDownIcon />
      </Button>
    </motion.div>
  );
};
