import { useNavigate } from "@tanstack/react-router";
import { Button } from "@repo/ui/components/button";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";

import { Route } from "@/routes/index";
import { featuredGames } from "./data";

export const GameNavArrows = () => {
  const { game, view } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const currentIndex = featuredGames.findIndex((g) => g.slug === game);
  const len = featuredGames.length;

  const goTo = (index: number) => {
    const target = featuredGames[((index % len) + len) % len];
    if (target) {
      navigate({ search: { view: "play", game: target.slug } });
    }
  };

  if (view !== "play" || currentIndex === -1) return null;

  return (
    <div className="fixed right-4 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-1 md:flex">
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
    </div>
  );
};
