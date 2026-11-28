import { z } from "zod";

import { GAME_TAGS } from "@/components/game/data";

/** The gallery view's resource. Bump the version on a change an old host's cached copy would break. */
export const GALLERY_URI = "ui://vibedgames/gallery-v1.html";

export const browseInput = z.object({
  query: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Words to match against a game's name, description and tags"),
  tag: z.enum(GAME_TAGS).optional().describe("Only games with this tag"),
});

export const galleryGame = z.object({
  coverUrl: z.url().describe("Landscape cover image"),
  description: z.string(),
  name: z.string(),
  playUrl: z.url().describe("Where the game runs, in the browser"),
  portraitUrl: z.url().optional().describe("Portrait cover image"),
  slug: z.string(),
  tags: z.array(z.enum(GAME_TAGS)),
});

export const browseOutput = z.object({
  galleryUrl: z.url().describe("The gallery on the website"),
  games: z.array(galleryGame),
});

export type BrowseInput = z.infer<typeof browseInput>;

export type GalleryGame = z.infer<typeof galleryGame>;

export type BrowseOutput = z.infer<typeof browseOutput>;
