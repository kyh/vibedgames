// Cosmetic-only cannon-es tumble for the game-over collapse. The locked cube
// meshes are handed over and bounced around by a physics world with random
// horizontal gravity — purely a visual death animation. The actual rescue
// ("catch") is a deterministic board operation (Board.collapseDown), so the
// physics never has to be read back into game state.

import * as CANNON from "cannon-es";
import type { Mesh } from "three";

import { WELL_HEIGHT } from "../shared/constants";

type Pair = { mesh: Mesh; body: CANNON.Body };

export class Collapse {
  private world: CANNON.World | null = null;
  private pairs: Pair[] = [];

  attach(meshes: Mesh[]): void {
    const world = new CANNON.World();
    world.gravity.set((Math.random() * 2 - 1) * 4, -14, (Math.random() * 2 - 1) * 4);

    const ground = new CANNON.Body({ mass: 0 });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    ground.position.set(0, -0.5, 0);
    world.addBody(ground);

    for (const mesh of meshes) {
      const half = Math.max(0.1, mesh.scale.x * 0.46);
      const body = new CANNON.Body({
        mass: 1,
        position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(half, half, half)));
      // A nudge proportional to height so the top of the tower flies most.
      const lift = mesh.position.y / WELL_HEIGHT;
      body.angularVelocity.set(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      );
      body.velocity.set(
        (Math.random() - 0.5) * 4 * lift,
        2 * lift,
        (Math.random() - 0.5) * 4 * lift,
      );
      world.addBody(body);
      this.pairs.push({ mesh, body });
    }
    this.world = world;
  }

  active(): boolean {
    return this.world !== null;
  }

  step(dt: number): void {
    if (!this.world) return;
    this.world.step(1 / 60, dt, 3);
    for (const { mesh, body } of this.pairs) {
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(
        body.quaternion.x,
        body.quaternion.y,
        body.quaternion.z,
        body.quaternion.w,
      );
    }
  }

  dispose(): void {
    this.world = null;
    this.pairs = [];
  }
}
