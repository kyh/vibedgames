export type FeaturedGame = {
  id: number;
  name: string;
  preview: string;
  url: string;
};

export const featuredGames: FeaturedGame[] = [
  {
    id: 0,
    name: "Demo",
    preview: "/demo/thumbnail.png",
    url: "/demo",
  },
  {
    id: 1,
    name: "Flappy Bird",
    preview: "/flappy-bird/thumbnail.png",
    url: "https://flappy-bird.vibedgames.com",
  },
  {
    id: 2,
    name: "Pacman",
    preview: "/pacman/thumbnail.png",
    url: "https://pacman.vibedgames.com",
  },
  {
    id: 3,
    name: "Tetris",
    preview: "/tetris/thumbnail.png",
    url: "https://tetris.vibedgames.com",
  },
  {
    id: 4,
    name: "Pong",
    preview: "/pong/thumbnail.png",
    url: "https://pong.vibedgames.com",
  },
];
