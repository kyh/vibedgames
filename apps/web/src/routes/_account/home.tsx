import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gamepad2Icon, Trash2Icon } from "lucide-react";
import { motion } from "motion/react";

import { alertDialog } from "@repo/ui/components/alert-dialog";
import { Button } from "@repo/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@repo/ui/components/empty";
import { Skeleton } from "@repo/ui/components/skeleton";
import { toast } from "@repo/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip";

import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { INSTALL_PROMPT } from "@/lib/install-prompt";
import { useTRPC } from "@/lib/trpc";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export const Route = createFileRoute("/_account/home")({
  head: () => ({ meta: [{ title: "Home — Vibedgames" }] }),
  component: GamesPage,
});

const gameUrl = (slug: string) => `https://${slug}.vibedgames.com`;

/** "Jan 15", with the year appended once it stops being this year. */
const formatDate = (date: Date): string => {
  const d = new Date(date);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/**
 * The game's real favicon (served from its live subdomain), falling back to
 * a monogram tile — most games ship `<link rel="icon" href="data:,">` and
 * have no favicon file. Live is the default state so it gets no marker; a
 * grey dot flags a game with no current deployment (first deploy still
 * uploading, or an abandoned one). The current deployment can only ever be
 * a finalized/ready one, so there's no in-between state to render.
 */
function GameTile({ slug, name, live }: { slug: string; name: string; live: boolean }) {
  const [faviconFailed, setFaviconFailed] = useState(false);

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="relative flex size-7 shrink-0 select-none" />}>
        {faviconFailed ? (
          <span className="bg-white/8 text-foreground flex size-full items-center justify-center rounded-md text-xs font-medium uppercase">
            {name.slice(0, 1)}
          </span>
        ) : (
          <img
            src={`${gameUrl(slug)}/favicon.png`}
            alt=""
            loading="lazy"
            onError={() => setFaviconFailed(true)}
            className="size-full rounded-md object-cover"
          />
        )}
        {!live && (
          <span className="ring-background bg-muted-foreground absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2" />
        )}
      </TooltipTrigger>
      <TooltipContent side="top">{live ? "live" : "not deployed"}</TooltipContent>
    </Tooltip>
  );
}

function NoGamesYet() {
  const { copy } = useCopyToClipboard();

  return (
    <Empty className="min-h-[calc(100dvh-14rem)]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Gamepad2Icon />
        </EmptyMedia>
        <EmptyTitle>No games yet</EmptyTitle>
        <EmptyDescription>
          <p>
            Ask your coding agent to{" "}
            <button
              type="button"
              onClick={() => void copy(INSTALL_PROMPT)}
              className="hover:text-foreground cursor-pointer rounded-sm underline underline-offset-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/30"
            >
              build one
            </button>
            ,
          </p>
          <p>then ask it to "ship it"</p>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function GamesSkeleton() {
  return (
    <div>
      <div className="text-muted-foreground flex items-center justify-between border-b border-white/10 pb-2 text-xs">
        <span>Game</span>
        <span>Last Updated</span>
      </div>
      <ul className="pt-1">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="flex items-center gap-3 py-2">
            <Skeleton className="size-7" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="ml-auto h-3 w-10" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function GamesPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  // One shared row highlight that springs to the hovered row (motion
  // layoutId) instead of per-row hover backgrounds. Hover and focus-within
  // paint the SAME surface as the rail disc in account-shell — one highlight
  // recipe app-wide; keep them in lockstep.
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const list = useQuery(trpc.deploy.list.queryOptions());
  const remove = useMutation(
    trpc.deploy.delete.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.deploy.list.queryKey() });
        toast.success("Game deleted");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const confirmDelete = (game: { id: string; slug: string }) => {
    alertDialog.open(`Delete ${game.slug}?`, {
      description:
        "This takes the game offline and permanently deletes its files and source. There is no undo.",
      action: {
        label: "Delete",
        onClick: () => remove.mutateAsync({ gameId: game.id }),
      },
    });
  };

  return (
    <section>
      <h1 className="sr-only">Home</h1>

      {list.isError && (
        <p className="text-muted-foreground text-sm">Couldn't load your games. Try reloading.</p>
      )}

      {!list.isError && (
        <SkeletonReveal ready={list.data !== undefined} skeleton={<GamesSkeleton />}>
          {list.data && list.data.games.length === 0 && <NoGamesYet />}

          {list.data && list.data.games.length > 0 && (
            <div>
              <div className="text-muted-foreground flex items-center justify-between border-b border-white/10 pb-2 text-xs">
                <span>Game</span>
                <span>Last Updated</span>
              </div>
              <ul className="pt-1 text-sm" onMouseLeave={() => setHoveredRow(null)}>
                {list.data.games.map((g) => {
                  const name = g.name ?? g.slug;
                  const deployed = g.deployment !== null;
                  return (
                    <li
                      key={g.id}
                      onMouseEnter={() => setHoveredRow(g.id)}
                      className="group relative -mx-3 flex items-center gap-3 rounded-lg px-3 py-2 focus-within:bg-white/10 focus-within:shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] focus-within:backdrop-blur-sm"
                    >
                      {hoveredRow === g.id && (
                        <motion.span
                          layoutId="row-highlight"
                          transition={{ type: "spring", bounce: 0.15, duration: 0.3 }}
                          className="absolute inset-0 -z-10 rounded-lg bg-white/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-sm"
                        />
                      )}
                      <GameTile slug={g.slug} name={name} live={deployed} />
                      <div className="flex min-w-0 items-baseline gap-2">
                        {deployed ? (
                          <a
                            href={gameUrl(g.slug)}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-lg"
                          >
                            {name}
                          </a>
                        ) : (
                          <span className="truncate font-medium">{name}</span>
                        )}
                        <span className="text-muted-foreground truncate font-mono text-xs">
                          {g.slug}.vibedgames.com
                        </span>
                      </div>
                      <div className="relative ml-auto flex shrink-0 items-center justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${name}`}
                          className="peer absolute top-1/2 right-0 z-10 -translate-y-1/2 opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => confirmDelete(g)}
                          loading={remove.isPending && remove.variables?.gameId === g.id}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                        <span className="text-muted-foreground text-xs tabular-nums transition-opacity duration-100 group-hover:opacity-0 peer-focus-visible:opacity-0">
                          {formatDate(g.updatedAt)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </SkeletonReveal>
      )}
    </section>
  );
}
