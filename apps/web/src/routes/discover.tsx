import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";

import { featuredGames, gameSearchSchema } from "@/components/game/data";

export const Route = createFileRoute("/discover")({
  validateSearch: gameSearchSchema,
  head: () => ({ meta: [{ title: "Discover — Vibedgames" }] }),
  component: DiscoverPage,
});

function DiscoverPage() {
  const navigate = useNavigate();
  const { game: activeGame } = Route.useSearch();

  return (
    <header className="fixed bottom-16 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 md:w-96">
      <motion.div
        className="flex gap-4 overflow-auto pb-4 md:flex-col-reverse"
        transition={{ type: "spring", bounce: 0.1 }}
        initial={{ opacity: 0, filter: "blur(5px)" }}
        animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: 0.05 } }}
      >
        {featuredGames.map((game) => (
          <button
            key={game.slug}
            onMouseEnter={() => {
              if (activeGame === game.slug) return;
              void navigate({ to: "/discover", search: { game: game.slug }, replace: true });
            }}
            onClick={() => void navigate({ to: "/", search: { game: game.slug } })}
            className="hover:border-foreground relative aspect-video w-30 shrink-0 overflow-clip rounded-lg border border-transparent transition-colors"
          >
            <img
              src={game.preview}
              alt={game.name}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </button>
        ))}
      </motion.div>
    </header>
  );
}
