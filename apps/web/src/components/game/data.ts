export type FeaturedGame = {
  name: string;
  preview: string;
  colorScheme: "light" | "dark";
  url: string;
};

export const featuredGames: FeaturedGame[] = [
  {
    name: "Astroid",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/astroid.png",
    url: "https://astroid.vibedgames.com",
    colorScheme: "dark",
  },
  {
    name: "Flappy Bird",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/flappy.png",
    url: "https://flappy-bird.vibedgames.com",
    colorScheme: "light",
  },
  {
    name: "Pacman",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pacman.png",
    url: "https://pacman.vibedgames.com",
    colorScheme: "dark",
  },
  {
    name: "Tetris",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/tetris.png",
    url: "https://tetris.vibedgames.com",
    colorScheme: "dark",
  },
  {
    name: "Pong",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    url: "https://pong.vibedgames.com",
    colorScheme: "light",
  },
];
