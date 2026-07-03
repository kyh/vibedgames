import { z } from "zod";

export type FeaturedGame = {
  name: string;
  slug: string;
  preview: string;
  /** Optional portrait key art, served when the viewport is portrait. */
  previewPortrait?: string;
  colorScheme: "light" | "dark";
};

export const gameUrl = (slug: string) => `https://${slug}.vibedgames.com`;

export const gameSearchSchema = z.object({
  game: z.string().default("starfall"),
});

export type GameSearch = z.infer<typeof gameSearchSchema>;

export const featuredGames: FeaturedGame[] = [
  {
    name: "Starfall",
    slug: "starfall",
    preview: "/covers/starfall.webp",
    previewPortrait: "/covers/starfall-portrait.webp",
    colorScheme: "dark",
  },
  {
    name: "Flappy Dragons",
    slug: "flappy-dragons",
    preview: "/covers/flappy-dragons.webp",
    previewPortrait: "/covers/flappy-dragons-portrait.webp",
    colorScheme: "light",
  },
  {
    name: "Pacman",
    slug: "pacman",
    preview: "/covers/pacman.webp",
    previewPortrait: "/covers/pacman-portrait.webp",
    colorScheme: "dark",
  },
  {
    name: "Tetris",
    slug: "tetris",
    preview: "/covers/tetris.webp",
    previewPortrait: "/covers/tetris-portrait.webp",
    colorScheme: "dark",
  },
  {
    name: "Pong",
    slug: "pong",
    preview: "/covers/pong.webp",
    previewPortrait: "/covers/pong-portrait.webp",
    colorScheme: "light",
  },
  {
    name: "Bomberman",
    slug: "bomberman",
    preview: "/covers/bomberman.webp",
    previewPortrait: "/covers/bomberman-portrait.webp",
    colorScheme: "light",
  },
  {
    name: "Ancients of Eldermoor",
    slug: "moba",
    preview: "/covers/moba.webp",
    previewPortrait: "/covers/moba-portrait.webp",
    colorScheme: "light",
  },
  {
    name: "Farm",
    slug: "farm",
    preview: "/covers/farm.webp",
    previewPortrait: "/covers/farm-portrait.webp",
    colorScheme: "light",
  },
  {
    name: "Battle Arena",
    slug: "battle-arena",
    preview: "/covers/battle-arena.webp",
    previewPortrait: "/covers/battle-arena-portrait.webp",
    colorScheme: "dark",
  },
  {
    name: "Crazy Waymo",
    slug: "crazy-waymo",
    preview: "/covers/crazy-waymo.webp",
    previewPortrait: "/covers/crazy-waymo-portrait.webp",
    colorScheme: "light",
  },
];
