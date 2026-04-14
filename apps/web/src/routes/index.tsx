import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { PageClient } from "@/components/game/page";
import { featuredGames } from "@/components/game/data";

const searchSchema = z.object({
  view: z.enum(["play", "discover"]).default("discover"),
  game: z.string().optional(),
});

export type HomeSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: () => <PageClient />,
});
