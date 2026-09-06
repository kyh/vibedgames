import RAPIER from "@dimforge/rapier3d-compat";
import { RaycastVehicle } from "../src/vehicle/raycast-vehicle.ts";

type Check = (name: string, passed: boolean, detail?: string) => void;

/** A parked taxi must not slide sideways into a building on SF's hills. */
export async function checkVehicleParking(check: Check): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -30, z: 0 });
  world.timestep = 1 / 60;
  const pitch = Math.atan(0.4);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(80, 0.2, 80)
      .setTranslation(0, -0.2, 0)
      .setRotation({ x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) })
      .setFriction(0.9),
  );
  const vehicle = new RaycastVehicle({ raw: () => world }, 0, 1.4, 0, Math.PI / 2);
  const advance = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      vehicle.fixedStep(1 / 60);
      world.step();
    }
  };
  vehicle.setControls({ throttle: 0, brake: 0, steer: 0, boost: false }, false);
  advance(180);
  const start = vehicle.chassis.translation();
  advance(480);
  const parked = vehicle.chassis.translation();
  const drift = Math.hypot(parked.x - start.x, parked.z - start.z);
  check("idle taxi holds a 40% cross-slope", drift < 0.4, `${drift.toFixed(3)}u drift in 8s`);
  vehicle.setControls({ throttle: 1, brake: 0, steer: 0, boost: false }, false);
  advance(120);
  const driven = vehicle.chassis.translation();
  const distance = Math.hypot(driven.x - parked.x, driven.z - parked.z);
  check("throttle immediately releases hill hold", distance > 5, `${distance.toFixed(1)}u in 2s`);
  vehicle.dispose();
  world.free();
}
