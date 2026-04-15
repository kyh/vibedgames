import { useNavigate } from "@tanstack/react-router";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";

import { Route } from "@/routes/index";
import { featuredGames } from "./data";

export const GameNavArrows = () => {
  const { game, view } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const currentIndex = featuredGames.findIndex((g) => g.url === game);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < featuredGames.length - 1;

  const goTo = (index: number) => {
    const target = featuredGames[index];
    if (target) {
      navigate({ search: { view: "play", game: target.url } });
    }
  };

  if (view !== "play") return null;

  return (
    <div className="fixed right-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1">
      <button
        onClick={() => hasPrev && goTo(currentIndex - 1)}
        disabled={!hasPrev}
        className="text-muted-foreground hover:text-foreground rounded-full p-2 transition disabled:opacity-20 disabled:hover:text-muted-foreground"
        aria-label="Previous game"
      >
        <ChevronUpIcon className="size-5" />
      </button>
      <button
        onClick={() => hasNext && goTo(currentIndex + 1)}
        disabled={!hasNext}
        className="text-muted-foreground hover:text-foreground rounded-full p-2 transition disabled:opacity-20 disabled:hover:text-muted-foreground"
        aria-label="Next game"
      >
        <ChevronDownIcon className="size-5" />
      </button>
    </div>
  );
};
