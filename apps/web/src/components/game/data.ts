import { z } from "zod";

export type FeaturedGame = {
  name: string;
  slug: string;
  preview: string;
  colorScheme: "light" | "dark";
};

export const gameUrl = (slug: string) => `https://${slug}.vibedgames.com`;

export const gameSearchSchema = z.object({
  game: z.string().default("astroid"),
});

export type GameSearch = z.infer<typeof gameSearchSchema>;

export const featuredGames: FeaturedGame[] = [
  {
    name: "Astroid",
    slug: "astroid",
    preview: "/covers/astroid.webp",
    colorScheme: "dark",
  },
  {
    name: "Flappy Bird",
    slug: "flappy-bird",
    preview: "/covers/flappy-bird.webp",
    colorScheme: "light",
  },
  {
    name: "Pacman",
    slug: "pacman",
    preview: "/covers/pacman.webp",
    colorScheme: "dark",
  },
  {
    name: "Tetris",
    slug: "tetris",
    preview: "/covers/tetris.webp",
    colorScheme: "dark",
  },
  {
    name: "Pong",
    slug: "pong",
    preview: "/covers/pong.webp",
    colorScheme: "light",
  },
  {
    name: "Bomberman",
    slug: "bomberman",
    preview: "/covers/bomberman.webp",
    colorScheme: "light",
  },
];
