import { parklandAt } from "./land-class";

/**
 * Car-free park land. The Presidio is deliberately NOT in it: parkland with a
 * real street network (and the Golden Gate Bridge approach anchors on its
 * northernmost road cell). That exemption is no longer a special case written
 * here — it is `carFree: false` on the `openSpace` variant in land-class.ts,
 * which every consumer of the ground rule can see.
 */
export const parkCell: (gx: number, gz: number) => boolean = (gx, gz) => {
  const p = parklandAt(gx, gz);

  return p.kind !== "none" && p.carFree;
};
