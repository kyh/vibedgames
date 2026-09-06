import * as THREE from "three";

import { Fx } from "../src/fx/particles.ts";
import {
  readTireContact,
  SURFACE_FX,
  SURFACE_FX_MAX_BURSTS,
  SURFACE_FX_MAX_RATE,
  TireEmissionClock,
  tireThrow,
} from "../src/fx/surface-fx.ts";
import type { WheelSurface } from "../src/world/land-class.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;
const LOOSE: readonly WheelSurface[] = ["grass", "sand", "dirt", "gravel", "rock"];

function emissions(surface: WheelSurface, speed: number, hz: number): number {
  const clock = new TireEmissionClock();
  let bursts = 0;
  for (let i = 0; i < hz * 10; i++) bursts += clock.step(1 / hz, surface, speed, true);
  return bursts;
}

function alive(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  let count = 0;
  for (let i = 0; i < attribute.count; i++) if (attribute.getX(i) > 0) count++;
  return count;
}

/** Contact, surface transitions, reverse travel and real particle-pool budgets. */
export function checkSurfaceFx(check: Check): void {
  const clock = new TireEmissionClock();
  let quiet = true;
  for (let i = 0; i < 100; i++) {
    quiet &&= clock.step(1 / 60, "sand", 0, true) === 0;
    quiet &&= clock.step(1 / 60, null, 40, true) === 0;
    quiet &&= clock.step(1 / 60, "road", 40, false) === 0;
  }
  check("parked, airborne and cruising paved tires emit no surface matter", quiet);

  clock.step(0.049, "sand", 40, true);
  clock.step(1 / 60, null, 40, true);
  check("lost contact cannot bank a landing burst", clock.step(0.01, "sand", 40, true) === 0);
  clock.step(0.03, "sand", 40, true);
  check("crossing materials resets the tire cadence", clock.step(0.01, "gravel", 40, true) === 0);
  check(
    "stalled frames cap surface bursts and discard the backlog",
    clock.step(20, "sand", 80, true) <= SURFACE_FX_MAX_BURSTS &&
      clock.step(0, "sand", 80, true) === 0 &&
      clock.step(1 / 120, "sand", 80, true) === 0,
  );

  check(
    "reverse travel emits the same surface cadence as forward travel",
    LOOSE.every((surface) => emissions(surface, -35, 60) === emissions(surface, 35, 60)),
  );
  check(
    "surface cadence stays stable at 30, 60 and 144Hz",
    LOOSE.every((surface) => {
      const rates = [30, 60, 144].map((hz) => emissions(surface, 40, hz));
      return Math.max(...rates) - Math.min(...rates) <= 1;
    }),
  );
  check(
    "loose-ground emission stays capped at 18 bursts per tire per second",
    LOOSE.every((surface) => emissions(surface, 300, 144) <= SURFACE_FX_MAX_RATE * 10),
  );

  const point = { x: 0, y: 0, z: 0 };
  const airborneContact = {
    wheelIsInContact: () => false,
    wheelContactPoint: () => ({ x: 10, y: 6, z: 20 }),
  };
  check(
    "rear tires stop immediately during the car's airborne grace period",
    !readTireContact(airborneContact, 2, true, point),
  );
  const partialContact = {
    wheelIsInContact: (index: number) => index === 3,
    wheelContactPoint: (_index: number, target = { x: 0, y: 0, z: 0 }) => {
      target.x = 10;
      target.y = 6;
      target.z = 20;
      return target;
    },
  };
  check(
    "partial wheel contact preserves the contacted tire's deck position",
    !readTireContact(partialContact, 2, true, point) &&
      readTireContact(partialContact, 3, true, point) &&
      point.x === 10 &&
      point.y === 6 &&
      point.z === 20,
  );
  check(
    "missing ray hit never emits and the pre-physics fallback respects grounding",
    !readTireContact(
      { wheelIsInContact: () => true, wheelContactPoint: () => null },
      2,
      true,
      point,
    ) &&
      !readTireContact(null, 2, false, point) &&
      readTireContact(null, 2, true, point),
  );

  const direction = { x: 0, y: 0, z: 0 };
  tireThrow(0, -20, direction);
  const reverse = direction.z === 1;
  tireThrow(12, 16, direction);
  const side = Math.abs(direction.x + 0.6) < 1e-9 && Math.abs(direction.z + 0.8) < 1e-9;
  const throwCap = tireThrow(200, 0, direction);
  tireThrow(0, 0, direction);
  check(
    "tire throw follows actual reverse/sideways travel and caps at speed",
    reverse && side && throwCap <= 3.8 && direction.x === 0 && direction.z === 0,
  );

  check(
    "loose surfaces have distinct dust, debris and cadence profiles",
    new Set(LOOSE.map((surface) => JSON.stringify(SURFACE_FX[surface]))).size === LOOSE.length &&
      SURFACE_FX.sand.dust.spread > SURFACE_FX.dirt.dust.spread &&
      SURFACE_FX.grass.debris.color.g > SURFACE_FX.grass.debris.color.r &&
      SURFACE_FX.gravel.debris.gravity > SURFACE_FX.grass.debris.gravity &&
      SURFACE_FX.rock.rate < SURFACE_FX.gravel.rate,
  );

  const fx = new Fx();
  const scene = new THREE.Scene();
  fx.addTo(scene);
  const smoke = fx.smoke.points.geometry;
  const sparks = fx.sparks.points.geometry;
  const poolSize = smoke.getAttribute("aLife").count;
  const attributes = Object.values(smoke.attributes);
  const maxSizes: number[] = [];
  let particles = 0;
  let maxAlive = 0;
  let allExpired = true;
  for (const surface of LOOSE) {
    const profile = SURFACE_FX[surface];
    if (profile.kind !== "loose") throw new Error("Loose fixture resolved as pavement");
    const cadence = new TireEmissionClock();
    tireThrow(0, 55, direction);
    for (let frame = 0; frame < 360; frame++) {
      const bursts = cadence.step(1 / 60, surface, 55, true);
      for (let burst = 0; burst < bursts * 2; burst++) {
        fx.kickup(0, 0, 0, profile, direction, 3.8);
        particles += profile.dust.count + profile.debris.count;
      }
      fx.update(1 / 60);
      maxAlive = Math.max(maxAlive, alive(smoke.getAttribute("aLife")));
    }
    const sizes = smoke.getAttribute("aSize");
    for (let i = 0; i < sizes.count; i++) maxSizes.push(sizes.getX(i));
    fx.update(0.6);
    allExpired &&= alive(smoke.getAttribute("aLife")) === 0;
  }
  const material = fx.smoke.points.material;
  check(
    "off-road particles stay normal-blend and never occupy the spark pool",
    material instanceof THREE.ShaderMaterial &&
      material.blending === THREE.NormalBlending &&
      alive(sparks.getAttribute("aLife")) === 0 &&
      alive(smoke.getAttribute("aGrain")) > 0,
  );
  check(
    "all loose surfaces clear within 600ms and keep point sizes compact",
    allExpired && Math.max(...maxSizes) <= 1.25 * 1.3 + 1e-6,
  );
  check(
    "sustained off-road drive keeps under 80 live particles and reuses fixed buffers",
    maxAlive < 80 &&
      particles > poolSize * 4 &&
      poolSize === 420 &&
      scene.children.length === 5 &&
      !fx.water.mesh.visible &&
      Object.values(smoke.attributes).every((attribute, i) => attribute === attributes[i]),
    `${maxAlive} peak live; ${particles} emissions; ${poolSize} pooled slots; water draw remains hidden`,
  );
}
