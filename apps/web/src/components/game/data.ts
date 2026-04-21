import { z } from "zod";

export type FeaturedGame = {
  name: string;
  slug: string;
  preview: string;
  colorScheme: "light" | "dark";
};

export const gameUrl = (slug: string) =>
  `https://${slug}.vibedgames.com`;

export const gameSearchSchema = z.object({
  game: z.string().default("astroid"),
});

export type GameSearch = z.infer<typeof gameSearchSchema>;

export const featuredGames: FeaturedGame[] = [
  {
    name: "Astroid",
    slug: "astroid",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/astroid.png",
    colorScheme: "dark",
  },
  {
    name: "Flappy Bird",
    slug: "flappy-bird",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/flappy.png",
    colorScheme: "light",
  },
  {
    name: "Pacman",
    slug: "pacman",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pacman.png",
    colorScheme: "dark",
  },
  {
    name: "Tetris",
    slug: "tetris",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/tetris.png",
    colorScheme: "dark",
  },
  {
    name: "Pong",
    slug: "pong",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    colorScheme: "light",
  },
];
