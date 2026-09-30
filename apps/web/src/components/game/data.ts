import { z } from "zod";

export interface FeaturedGame {
  name: string;
  description: string;
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
    description:
      "Top-down 32-player arena shooter: drop into a shared arena, level up, and fight for the top of the board.",
    name: "Starfall",
    preview: "/covers/starfall.webp",
    previewPortrait: "/covers/starfall-portrait.webp",
    slug: "starfall",
  },
  {
    colorScheme: "light",
    description:
      "Flappy-style dragon flight you can steer by flapping your arms at the webcam, with other players as ghost dragons.",
    name: "Flappy Dragons",
    preview: "/covers/flappy-dragons.webp",
    previewPortrait: "/covers/flappy-dragons-portrait.webp",
    slug: "flappy-dragons",
  },
  {
    colorScheme: "dark",
    description:
      "Maze chase in a plush clinic, steered by turning your head and chomping with your mouth via the webcam.",
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
    description: "Pong in dithered 3D, steered by webcam hand tracking, with online 1v1.",
    name: "Pong",
    preview: "/covers/pong.webp",
    previewPortrait: "/covers/pong-portrait.webp",
    slug: "pong",
  },
  {
    colorScheme: "light",
    description:
      "Arcade driving through a real-map San Francisco picking up fares, with day and night tied to the SF clock.",
    name: "Crazy Waymo",
    preview: "/covers/crazy-waymo.webp",
    previewPortrait: "/covers/crazy-waymo-portrait.webp",
    slug: "crazy-waymo",
  },
  {
    colorScheme: "light",
    description:
      "Keyboard-first action MOBA: two lanes, six heroes, creep waves, towers and jungle camps.",
    name: "Ancients of Eldermoor",
    preview: "/covers/moba.webp",
    previewPortrait: "/covers/moba-portrait.webp",
    slug: "moba",
  },
  {
    colorScheme: "dark",
    description:
      "3D online PvP action-RPG: pick a champion and fight bots or other players in a dungeon hall.",
    name: "Battle Arena",
    preview: "/covers/battle-arena.webp",
    previewPortrait: "/covers/battle-arena-portrait.webp",
    slug: "battle-arena",
  },
  {
    colorScheme: "dark",
    description:
      "Pixel-art roguelite dungeon crawl with five heroes, procedural rooms, online co-op and versus.",
    name: "Lunerfall",
    preview: "/covers/lunerfall.webp",
    previewPortrait: "/covers/lunerfall-portrait.webp",
    slug: "lunerfall",
  },
  {
    colorScheme: "light",
    description: "Top-down bomberman arena with online multiplayer and a solo fallback.",
    name: "Bomberman",
    preview: "/covers/bomberman.webp",
    previewPortrait: "/covers/bomberman-portrait.webp",
    slug: "bomberman",
  },
  {
    colorScheme: "light",
    description:
      "Stardew-like farming RPG: crops, fishing, mine combat, animals, NPCs and seasons.",
    name: "Farm",
    preview: "/covers/farm.webp",
    previewPortrait: "/covers/farm-portrait.webp",
    slug: "farm",
  },
  {
    colorScheme: "light",
    description:
      "3D battle royale brawler: nine medieval champions, seven bots, and closing poison gas.",
    name: "Showdown",
    preview: "/covers/showdown.webp",
    previewPortrait: "/covers/showdown-portrait.webp",
    slug: "showdown",
  },
];
