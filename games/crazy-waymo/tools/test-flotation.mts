import RAPIER from "@dimforge/rapier3d-compat";
import { Vector3 } from "three";
import { RaycastVehicle } from "../src/vehicle/raycast-vehicle";
import {
  waterBodyContains,
  waterBedHeight,
  type WaterBody,
  type WaterSampler,
} from "../src/world/water";

type Check = (name: string, passed: boolean, detail?: string) => void;
const DT = 1 / 60;
const STILL = { throttle: 0, brake: 0, steer: 0, boost: false };
const SEA: WaterSampler = { waterHeightAt: () => 0 };

function step(world: RAPIER.World, taxi: RaycastVehicle, count: number): void {
  for (let i = 0; i < count; i++) {
    taxi.fixedStep(DT);
    world.step();
  }
}

function fixture(y = 1, sampler = SEA) {
  const world = new RAPIER.World({ x: 0, y: -30, z: 0 });
  world.timestep = DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -9, 0));
  const taxi = new RaycastVehicle({ raw: () => world }, 0, y, 0, 0);
  taxi.setWaterSampler(sampler);
  taxi.setControls(STILL, false);
  return { world, taxi };
}

export async function checkFlotation(check: Check): Promise<void> {
  await RAPIER.init();
  let forwardCoastTravel = 0;
  for (const direction of [-1, 1]) {
    const { world, taxi } = fixture();
    step(world, taxi, 180);
    taxi.chassis.setLinvel({ x: 0, y: 0, z: direction * 27 }, true);
    step(world, taxi, 120);
    if (direction > 0) forwardCoastTravel = taxi.position.z;
    check(
      `${direction < 0 ? "reverse" : "forward"} water entry sheds road speed within a small basin`,
      taxi.waterContact.kind === "floating" && Math.abs(taxi.position.z) < 20 && taxi.speed < 2,
      `travel=${Math.abs(taxi.position.z).toFixed(2)}u, speed=${taxi.speed.toFixed(2)}`,
    );
    taxi.dispose();
    world.free();
  }
  {
    const { world, taxi } = fixture();
    step(world, taxi, 180);
    taxi.chassis.setLinvel({ x: 0, y: 0, z: 27 }, true);
    taxi.setControls({ ...STILL, brake: 1 }, false);
    let furthest = 0;
    for (let i = 0; i < 120; i++) {
      step(world, taxi, 1);
      furthest = Math.max(furthest, taxi.position.z);
    }
    check(
      "water brake retains passive drag and stops before coasting, then reverses",
      furthest > 5 && furthest < forwardCoastTravel - 1 && taxi.chassis.linvel().z < -1,
      `brake=${furthest.toFixed(2)}u, coast=${forwardCoastTravel.toFixed(2)}u`,
    );
    taxi.dispose();
    world.free();
  }
  const rectangle: WaterBody = {
    kind: "rectangle",
    x: 8,
    z: -4,
    y: 3,
    halfX: 4,
    halfZ: 1,
    yaw: Math.PI / 2,
  };
  const ellipse: WaterBody = { ...rectangle, kind: "ellipse" };
  check(
    "authored water footprints retain rotation and shape",
    waterBodyContains(rectangle, 8, -7.5) &&
      !waterBodyContains(rectangle, 10, -4) &&
      !waterBodyContains(ellipse, 8.9, -7.5),
  );
  check(
    "authored water carves a real local bed without changing dry ground",
    waterBedHeight([rectangle], 8, -4, 4) === 1.5 && waterBedHeight([rectangle], 20, -4, 4) === 4,
  );

  {
    const { world, taxi } = fixture();
    step(world, taxi, 360);
    const firstY = taxi.position.y;
    step(world, taxi, 120);
    check(
      "floating taxi settles at its waterline without sinking or bobble growth",
      taxi.waterContact.kind === "floating" &&
        Math.abs(firstY - 0.42) < 0.05 &&
        Math.abs(taxi.position.y - firstY) < 0.01,
      `bodyY=${taxi.position.y.toFixed(3)}`,
    );
    taxi.setControls(STILL, true);
    step(world, taxi, 120);
    check(
      "boost alone propels a floating taxi without the gas pedal",
      taxi.speed > 8 && taxi.position.z > 6,
    );
    taxi.teleport(0, 0.42, 0, 0);
    taxi.setControls({ ...STILL, throttle: 1 }, false);
    step(world, taxi, 180);
    check(
      "water throttle propels the taxi from rest",
      taxi.position.z > 12 && taxi.speed > 6,
      `distance=${taxi.position.z.toFixed(2)}, speed=${taxi.speed.toFixed(2)}`,
    );
    const beforeBrake = taxi.speed;
    taxi.setControls({ ...STILL, brake: 1 }, false);
    step(world, taxi, 40);
    check("water brake slows before engaging reverse", taxi.speed < beforeBrake * 0.3);
    step(world, taxi, 120);
    const v = taxi.chassis.linvel(),
      f = taxi.forwardDir(new Vector3());
    check("held water brake reverses using the existing pedal", v.x * f.x + v.z * f.z < -3);
    taxi.setControls({ ...STILL, throttle: 1 }, false);
    taxi.steerInput = 0.8;
    step(world, taxi, 180);
    taxi.forwardDir(f);
    check(
      "water steering turns and moves laterally",
      Math.abs(Math.atan2(f.x, f.z)) > 0.5 && Math.abs(taxi.position.x) > 2,
    );
    check(
      "floating resets airborne and drift scoring state",
      taxi.airTimeSeconds === 0 && !taxi.isDrifting && taxi.driftTier === 0,
    );
    taxi.dispose();
    world.free();
  }

  {
    const { world, taxi } = fixture(32);
    taxi.chassis.setLinvel({ x: 12, y: -24, z: 0 }, true);
    let low = Infinity,
      finite = true,
      impact = 0;
    for (let i = 0; i < 420; i++) {
      step(world, taxi, 1);
      const p = taxi.position;
      low = Math.min(low, p.y);
      finite &&= [p.x, p.y, p.z, taxi.speed].every(Number.isFinite);
      if (taxi.waterContact.kind === "floating") impact = taxi.waterContact.entryVerticalSpeed;
    }
    check(
      "high falls shed impact energy and settle without a rescue teleport",
      finite && low > -0.8 && Math.abs(taxi.position.y - 0.42) < 0.05 && impact > 20,
      `lowest=${low.toFixed(2)}, entry=${impact.toFixed(2)}`,
    );
    taxi.dispose();
    world.free();
  }

  {
    const { world, taxi } = fixture(8.2);
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.3, 80).setTranslation(0, 6.7, 0));
    step(world, taxi, 180);
    check(
      "supported bridge and pier decks over water remain dry",
      taxi.waterContact.kind === "dry" && taxi.position.y > 7 && taxi.groundedWheels() >= 2,
    );
    taxi.dispose();
    world.free();
  }

  {
    const { world, taxi } = fixture(2, { waterHeightAt: (_x, z) => (z > 0 ? 0 : null) });
    const floor = new Float32Array([
      -40, 4, -30, -40, -4, 30, 40, 4, -30, 40, 4, -30, -40, -4, 30, 40, -4, 30,
    ]);
    world.createCollider(RAPIER.ColliderDesc.trimesh(floor, new Uint32Array([0, 1, 2, 3, 4, 5])));
    taxi.teleport(0, 2, -9, 0);
    step(world, taxi, 90);
    taxi.setControls({ ...STILL, throttle: 1 }, false);
    let entered = false;
    for (let i = 0; i < 240; i++) {
      step(world, taxi, 1);
      entered ||= taxi.waterContact.kind === "floating";
      if (entered && taxi.position.z > 8) break;
    }
    check(
      "continuous driving enters water through a shallow shore",
      entered && taxi.position.z > 6,
    );
    taxi.setControls({ ...STILL, brake: 1 }, false);
    let returned = false;
    // The downhill approach retains >20u/s of entry momentum. Allow its
    // braking distance plus the slower 5u/s reverse trip back to the bank.
    for (let i = 0; i < 720; i++) {
      step(world, taxi, 1);
      if (taxi.position.z < -6 && taxi.waterContact.kind === "dry" && taxi.groundedWheels() >= 2) {
        returned = true;
        break;
      }
    }
    check(
      "reverse exits the water and restores wheel driving",
      returned,
      `z=${taxi.position.z.toFixed(2)}, water=${taxi.waterContact.kind}`,
    );
    taxi.dispose();
    world.free();
  }
}
