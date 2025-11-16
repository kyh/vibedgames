export type FeaturedGame = {
  id: number;
  name: string;
  preview: string;
  url: string;
  colorScheme: "light" | "dark";
};

export const featuredGames: FeaturedGame[] = [
  {
    id: 0,
    name: "Astroid",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/astroid.png",
    url: "https://astroid.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 1,
    name: "Flappy Bird",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/flappy.png",
    url: "https://flappy-bird.vibedgames.com",
    colorScheme: "light",
  },
  {
    id: 2,
    name: "Pacman",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pacman.png",
    url: "https://pacman.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 3,
    name: "Tetris",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/tetris.png",
    url: "https://tetris.vibedgames.com",
    colorScheme: "dark",
  },
  {
    id: 4,
    name: "Pong",
    preview:
      "https://zmdrwswxugswzmcokvff.supabase.co/storage/v1/object/public/vibedgames/pong.png",
    url: "https://pong.vibedgames.com",
    colorScheme: "light",
  },
];
