import type { TracedMap } from "./traced";

// The parsed traced map is shared by world generation and the renderer; the
// sprite-placement objects inside must stay reference-identical between the
// two (the renderer's skip set is identity-based).
let cached: TracedMap | null = null;

export function setTracedMap(map: TracedMap): void {
  cached = map;
}

export function getTracedMap(): TracedMap {
  if (!cached) throw new Error("traced map not loaded yet (BootScene must run first)");
  return cached;
}
