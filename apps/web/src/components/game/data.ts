import { z } from "zod";

export const GAME_TAGS = ["3d", "camera", "multiplayer"] as const;

export type GameTag = (typeof GAME_TAGS)[number];

export interface FeaturedGame {
  name: string;
  slug: string;
  description: string;
  tags: readonly GameTag[];
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
      "A top-down arena shooter for 32 players: drop in, level up and fight for the top of the board.",
    name: "Starfall",
    preview: "/covers/starfall.webp",
    previewPortrait: "/covers/starfall-portrait.webp",
    slug: "starfall",
    tags: ["multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "A 3D battle royale brawler: pick one of nine medieval champions and be the last one standing as the poison gas closes in.",
    name: "Showdown",
    preview: "/covers/showdown.webp",
    previewPortrait: "/covers/showdown-portrait.webp",
    slug: "showdown",
    tags: ["3d", "multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "A toy-car battle on a table with no walls: pick one of six cars, grab a power cube and knock the other seven off the edge.",
    name: "Bonk Derby",
    preview: "/covers/bonk-derby.webp",
    previewPortrait: "/covers/bonk-derby-portrait.webp",
    slug: "bonk-derby",
    tags: ["multiplayer"],
  },
  {
    colorScheme: "dark",
    description:
      "A first-person shooter on a rain-soaked container dock at dusk, online deathmatch topped up with bots.",
    name: "Strikeforce",
    preview: "/covers/strikeforce.webp",
    previewPortrait: "/covers/strikeforce-portrait.webp",
    slug: "strikeforce",
    tags: ["3d", "multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "Flap a dragon through the gaps by flapping your arms at the webcam, with other players as ghost dragons.",
    name: "Flappy Dragons",
    preview: "/covers/flappy-dragons.webp",
    previewPortrait: "/covers/flappy-dragons-portrait.webp",
    slug: "flappy-dragons",
    tags: ["camera", "multiplayer"],
  },
  {
    colorScheme: "dark",
    description:
      "A 3D maze chase in a plush clinic: open your mouth to chomp and turn your head to steer.",
    name: "Pacman",
    preview: "/covers/pacman.webp",
    previewPortrait: "/covers/pacman-portrait.webp",
    slug: "pacman",
    tags: ["3d", "camera", "multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "Pong in dithered 3D, steered by your hand in front of the webcam, online one on one.",
    name: "Pong",
    preview: "/covers/pong.webp",
    previewPortrait: "/covers/pong-portrait.webp",
    slug: "pong",
    tags: ["3d", "camera", "multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "Drive a Waymo around a real San Francisco picking up fares, with day and night on the city's own clock.",
    name: "Crazy Waymo",
    preview: "/covers/crazy-waymo.webp",
    previewPortrait: "/covers/crazy-waymo-portrait.webp",
    slug: "crazy-waymo",
    tags: ["3d"],
  },
  {
    colorScheme: "light",
    description:
      "A keyboard-first action MOBA on a two-lane map: six heroes, creep waves, towers and jungle camps.",
    name: "Ancients of Eldermoor",
    preview: "/covers/moba.webp",
    previewPortrait: "/covers/moba-portrait.webp",
    slug: "moba",
    tags: [],
  },
  {
    colorScheme: "dark",
    description:
      "A 3D online action RPG: pick a champion and fight bots or other players in a hexagonal dungeon hall.",
    name: "Battle Arena",
    preview: "/covers/battle-arena.webp",
    previewPortrait: "/covers/battle-arena-portrait.webp",
    slug: "battle-arena",
    tags: ["3d", "multiplayer"],
  },
  {
    colorScheme: "dark",
    description:
      "A pixel-art roguelite dungeon crawl with five heroes, online co-op and first-to-three versus.",
    name: "Lunerfall",
    preview: "/covers/lunerfall.webp",
    previewPortrait: "/covers/lunerfall-portrait.webp",
    slug: "lunerfall",
    tags: ["multiplayer"],
  },
  {
    colorScheme: "light",
    description: "A top-down bomberman arena with online multiplayer.",
    name: "Bomberman",
    preview: "/covers/bomberman.webp",
    previewPortrait: "/covers/bomberman-portrait.webp",
    slug: "bomberman",
    tags: ["multiplayer"],
  },
  {
    colorScheme: "light",
    description:
      "A farming RPG: grow crops, fish, fight in the mines, raise animals and befriend the town through the seasons.",
    name: "Farm",
    preview: "/covers/farm.webp",
    previewPortrait: "/covers/farm-portrait.webp",
    slug: "farm",
    tags: [],
  },
];
