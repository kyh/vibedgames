import * as THREE from "three";

import type { GoldenGatePlan } from "../world/golden-gate";
import { goldenGateSilhouette, goldenGateSolvedPlan } from "../world/golden-gate";
import { SilhouetteMesh } from "./silhouette-mesh";

/**
 * Every landmark stand-in the running world has, as one scene object with one
 * tick.
 *
 * The bridge's MESHES are baked (world/golden-gate.ts buildGoldenGate runs on
 * cold generation only), so nothing on the normal load path builds bridge
 * geometry at all — but BOTH paths solve the placement (city.ts
 * lightGoldenGate), so this picks the solved plan up on the frame after the
 * world lands, and rebuilds if the world is ever regenerated under it.
 *
 * The scene fog is a PARAMETER, not something to reach for: the stand-in has to
 * age on the same aerial-perspective curve as the geometry it stands in for,
 * and the day-night grade owns fogNear/fogFar. Passing it in is what let this
 * stop being a child of the far-terrain mesh (it used to read `mesh.parent` to
 * find the scene, and hung off the horizon band purely because that was the one
 * render-side object the scene already ticked).
 */
export class LandmarkSilhouettes {
  readonly object: THREE.Group = new THREE.Group();
  private goldenGate: SilhouetteMesh | null = null;
  private goldenGatePlan: GoldenGatePlan | null = null;

  constructor() {
    this.object.name = "landmark-silhouettes";
    // bars are world-space; this never moves
    this.object.matrixAutoUpdate = false;
  }

  update(fogColor: THREE.Color, night: number, fog: THREE.Fog | null): void {
    const plan = goldenGateSolvedPlan();
    if (plan !== this.goldenGatePlan) {
      this.goldenGatePlan = plan;
      if (this.goldenGate) {
        this.object.remove(this.goldenGate.mesh);
        this.goldenGate.dispose();
        this.goldenGate = null;
      }
      if (plan) {
        this.goldenGate = new SilhouetteMesh(goldenGateSilhouette(plan));
        this.object.add(this.goldenGate.mesh);
      }
    }
    this.goldenGate?.update(fogColor, night, fog);
  }

  dispose(): void {
    if (!this.goldenGate) {
      return;
    }
    this.object.remove(this.goldenGate.mesh);
    this.goldenGate.dispose();
    this.goldenGate = null;
    this.goldenGatePlan = null;
  }
}
