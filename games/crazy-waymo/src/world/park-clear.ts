import { GRID_X, GRID_Z } from "../shared/constants";
import { landuseGreenAt } from "./sf-landuse";
import { districtAt } from "./sf-map";

// Parks are car-free. The car-free-park POLICY now lives at bake time
// (tools/sf-data/bake-network.mts): it clips park-interior street sections out
// of the vector network AND rasterizes the shipped mask from the result, so
// grid and vectors agree by construction (no runtime filter, no drift). What
// remains here is the shared park-LAND test — the single definition of "which
// cells are park" — used by the grid coloring/terrain terraces and the tests.

// Park test = OSM landuse OR traced park district (Dolores etc. are stamped
// as districts; landuse alone misses parts of them) — mirrors ground.ts.
// The Presidio is EXEMPT: it's parkland with a real street network (and the
// Golden Gate Bridge approach anchors on its northernmost road cell).
export const parkCell = (gx: number, gz: number): boolean => {
  if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
  const d = districtAt(gx, gz);
  if (d.name === "the Presidio") return false;
  return landuseGreenAt(gx, gz) || d.character === "park";
};
