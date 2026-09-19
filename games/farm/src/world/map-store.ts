import type { WorldMap } from "./worldmap";

// The parsed world map is shared by world generation and the renderer; the
// sprite-placement objects inside must stay reference-identical between the
// two (the renderer's skip set is identity-based).
let cached: WorldMap | null = null;

export const setWorldMap = (map: WorldMap): void => {
  cached = map;
};

export const getWorldMap = (): WorldMap => {
  if (!cached) {
    throw new Error("world map not loaded yet (BootScene must run first)");
  }
  return cached;
};
