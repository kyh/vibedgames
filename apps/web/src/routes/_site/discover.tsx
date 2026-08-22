import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useWebHaptics } from "web-haptics/react";

import { ScrollArea } from "@repo/ui/components/scroll-area";

import { GitHubLink, RegisterLink } from "@/components/auth/register-link";
import { TextFallback } from "@/components/site/text-fallback";
import { discoverDoc } from "@/content/discover";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";
import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { featuredGames, gameSearchSchema } from "@/components/game/data";

export const Route = createFileRoute("/_site/discover")({
  validateSearch: gameSearchSchema,
  server: { handlers: { GET: docHandler(discoverDoc) } },
  headers: varyHeaders(),
  head: () => docHead(discoverDoc),
  component: DiscoverPage,
});

function DiscoverPage() {
  const navigate = useNavigate();
  const { game: activeGame } = Route.useSearch();
  const { trigger } = useWebHaptics();

  return (
    <>
      <TextFallback
        doc={discoverDoc}
        note="The gallery below needs JavaScript. Every game is a standalone page you can open directly."
      />
      <RegisterLink />
      <header className="fixed bottom-16 left-0 z-10 flex max-w-dvw flex-col px-4">
        <FadeInBlur>
          <ScrollArea viewportClassName="scroll-area-fade flex max-h-[70vh] gap-4 pb-2 sm:flex-col">
            {featuredGames.map((game) => (
              <button
                type="button"
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
          </ScrollArea>
        </FadeInBlur>
      </header>
      <GitHubLink />
    </>
  );
}
