import { useNavigate } from "@tanstack/react-router";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";

import { Route } from "@/routes/index";
import { featuredGames } from "./data";

export const GameNavArrows = () => {
  const { game, view } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const currentIndex = featuredGames.findIndex((g) => g.url === game);
  const len = featuredGames.length;

  const goTo = (index: number) => {
    const target = featuredGames[((index % len) + len) % len];
    if (target) {
      navigate({ search: { view: "play", game: target.url } });
    }
  };

  if (view !== "play" || currentIndex === -1) return null;

  return (
    <div className="fixed right-4 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-1 md:flex">
      <button
        onClick={() => goTo(currentIndex - 1)}
        className="text-muted-foreground hover:text-foreground rounded-full p-2 transition"
        aria-label="Previous game"
      >
        <ChevronUpIcon className="size-5" />
      </button>
      <button
        onClick={() => goTo(currentIndex + 1)}
        className="text-muted-foreground hover:text-foreground rounded-full p-2 transition"
        aria-label="Next game"
      >
        <ChevronDownIcon className="size-5" />
      </button>
    </div>
  );
};
