import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useWebHaptics } from "web-haptics/react";

import { GitHubLink, RegisterLink } from "@/components/auth/register-link";
import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { featuredGames, gameSearchSchema } from "@/components/game/data";

export const Route = createFileRoute("/_site/discover")({
  validateSearch: gameSearchSchema,
  head: () => ({ meta: [{ title: "Discover — Vibedgames" }] }),
  component: DiscoverPage,
});

function DiscoverPage() {
  const navigate = useNavigate();
  const { game: activeGame } = Route.useSearch();
  const { trigger } = useWebHaptics();

  return (
    <>
      <RegisterLink />
      <header className="fixed bottom-16 left-0 z-10 flex max-h-[70vh] max-w-dvw flex-col px-4">
        <FadeInBlur className="scroll-fade flex gap-4 overflow-auto pb-2 sm:flex-col-reverse">
          {featuredGames.map((game) => (
            <button
              key={game.slug}
              onMouseEnter={() => {
                if (activeGame === game.slug) return;
                void navigate({
                  to: "/discover",
                  search: { game: game.slug },
                  replace: true,
                });
              }}
              onClick={() => {
                trigger("selection");
                void navigate({ to: "/", search: { game: game.slug } });
              }}
              className="hover:border-foreground relative aspect-video w-30 shrink-0 overflow-clip rounded-lg border border-transparent transition-colors"
            >
              <img
                src={game.preview}
                alt={game.name}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </button>
          ))}
        </FadeInBlur>
      </header>
      <GitHubLink />
    </>
  );
}
