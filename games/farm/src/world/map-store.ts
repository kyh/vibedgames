import type { WorldMap } from "./worldmap";

let cached: WorldMap | null = null;

export const setWorldMap = (map: WorldMap) => {
  cached = map;
};

export const getWorldMap = () => {
  if (!cached) {
    throw new Error("world map not loaded yet (BootScene must run first)");
  }

  return cached;
};
