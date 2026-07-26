import { parklandAt } from "./land-class";

// Parks are car-free. The car-free-park POLICY now lives at bake time
// (tools/sf-data/bake-network.mts): it clips park-interior street sections out
// of the vector network AND rasterizes the shipped mask from the result, so
// grid and vectors agree by construction (no runtime filter, no drift). What
// remains here is the shared park-LAND test — the single definition of "which
// cells are car-free park" — used by the grid coloring/terrain terraces and the
// tests.

/**
 * Car-free park land. The Presidio is deliberately NOT in it: parkland with a
 * real street network (and the Golden Gate Bridge approach anchors on its
 * northernmost road cell). That exemption is no longer a special case written
 * here — it is `carFree: false` on the `openSpace` variant in land-class.ts,
 * which every consumer of the ground rule can see.
 */
export const parkCell = (gx: number, gz: number): boolean => {
  const p = parklandAt(gx, gz);
  return p.kind !== "none" && p.carFree;
};
