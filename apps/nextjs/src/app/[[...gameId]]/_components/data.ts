export type FeaturedGame = {
  gameId: string;
  name: string;
  preview: string;
  url?: string;
  files?: Record<string, string>;
  colorScheme: "light" | "dark";
};

export const featuredGames: FeaturedGame[] = [
  {
    gameId: "astroid",
    name: "Astroid",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/astroid.png",
    url: "https://astroid.vibedgames.com",
    colorScheme: "dark",
  },
  {
    gameId: "flappy-bird",
    name: "Flappy Bird",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/flappy.png",
    url: "https://flappy-bird.vibedgames.com",
    colorScheme: "light",
  },
  {
    gameId: "pacman",
    name: "Pacman",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pacman.png",
    url: "https://pacman.vibedgames.com",
    colorScheme: "dark",
  },
  {
    gameId: "tetris",
    name: "Tetris",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/tetris.png",
    url: "https://tetris.vibedgames.com",
    colorScheme: "dark",
  },
  {
    gameId: "pong",
    name: "Pong",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    url: "https://pong.vibedgames.com",
    colorScheme: "light",
  },
];
