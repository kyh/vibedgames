import { z } from "zod";

export interface FeaturedGame {
  name: string;
  slug: string;
  preview: string;
  previewPortrait?: string;
  colorScheme: "light" | "dark";
}

export const gameUrl = (slug: string) => `https://${slug}.vibedgames.com`;

export const gameSearchSchema = z.object({
  game: z.string().default("starfall"),
});

export type GameSearch = z.infer<typeof gameSearchSchema>;

export const featuredGames: FeaturedGame[] = [
  {
    colorScheme: "dark",
    name: "Starfall",
    preview: "/covers/starfall.webp",
    previewPortrait: "/covers/starfall-portrait.webp",
    slug: "starfall",
  },
  {
    colorScheme: "light",
    name: "Flappy Dragons",
    preview: "/covers/flappy-dragons.webp",
    previewPortrait: "/covers/flappy-dragons-portrait.webp",
    slug: "flappy-dragons",
  },
  {
    colorScheme: "dark",
    name: "Pacman",
    preview: "/covers/pacman.webp",
    previewPortrait: "/covers/pacman-portrait.webp",
    slug: "pacman",
  },
  // {
  //   name: "Tetris",
  //   slug: "tetris",
  //   preview: "/covers/tetris.webp",
  //   previewPortrait: "/covers/tetris-portrait.webp",
  //   colorScheme: "dark",
  // },
  {
    colorScheme: "light",
    name: "Pong",
    preview: "/covers/pong.webp",
    previewPortrait: "/covers/pong-portrait.webp",
    slug: "pong",
  },
  {
    colorScheme: "light",
    name: "Crazy Waymo",
    preview: "/covers/crazy-waymo.webp",
    previewPortrait: "/covers/crazy-waymo-portrait.webp",
    slug: "crazy-waymo",
  },
  {
    colorScheme: "light",
    name: "Ancients of Eldermoor",
    preview: "/covers/moba.webp",
    previewPortrait: "/covers/moba-portrait.webp",
    slug: "moba",
  },
  {
    colorScheme: "dark",
    name: "Battle Arena",
    preview: "/covers/battle-arena.webp",
    previewPortrait: "/covers/battle-arena-portrait.webp",
    slug: "battle-arena",
  },
  {
    colorScheme: "dark",
    name: "Lunerfall",
    preview: "/covers/lunerfall.webp",
    previewPortrait: "/covers/lunerfall-portrait.webp",
    slug: "lunerfall",
  },
  {
    colorScheme: "light",
    name: "Bomberman",
    preview: "/covers/bomberman.webp",
    previewPortrait: "/covers/bomberman-portrait.webp",
    slug: "bomberman",
  },
  {
    colorScheme: "light",
    name: "Farm",
    preview: "/covers/farm.webp",
    previewPortrait: "/covers/farm-portrait.webp",
    slug: "farm",
  },
];
