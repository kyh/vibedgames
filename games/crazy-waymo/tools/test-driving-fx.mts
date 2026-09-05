import * as THREE from "three";

import { BoostPlume } from "../src/fx/boost-plume.ts";
import { DriftTrails } from "../src/fx/trails.ts";
import { ChaseCamera } from "../src/fx/camera-rig.ts";
import { CAMERA } from "../src/shared/constants.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { CeilingIndex, deckCeilings, SolidIndex } from "../src/world/solid-index.ts";
import { DriveSurface } from "../src/world/surface.ts";
import { Terrain } from "../src/world/terrain.ts";
import type { CityRestPayload } from "../src/world/city.ts";
import type { AuditWorld } from "./geometry-audit.mts";

type Check = (name: string, condition: boolean, detail?: string) => void;

function pixelWidth(
  rig: ChaseCamera,
  car: { readonly position: THREE.Vector3; readonly heading: number },
): number {
  const dx = Math.cos(car.heading);
  const dz = -Math.sin(car.heading);
  const left = new THREE.Vector3(
    car.position.x - dx,
    car.position.y + 1,
    car.position.z - dz,
  ).project(rig.camera);
  const right = new THREE.Vector3(
    car.position.x + dx,
    car.position.y + 1,
    car.position.z + dz,
  ).project(rig.camera);
  return Math.abs(right.x - left.x) * 422;
}

function hillHeight(_x: number, z: number): number {
  const f = THREE.MathUtils.clamp(-z / 13, 0, 1);
  return -z * 0.72 + Math.sin(f * Math.PI) * 3;
}

/** This shipped pier stands over a ground cut, below the uncorrected field. */
export function checkWorldDrivingFx(check: Check, world: AuditWorld, rest: CityRestPayload): void {
  const surface = new DriveSurface(world.terrain, world.plan, () => world.network);
  surface.addDecks(rest.decks);
  const x = 196.144;
  const z = -1181.7585;
  const y = surface.heightAt(x, z);
  const normal = surface.normalInto(new THREE.Vector3(), x, z);
  check(
    "flat pier normal follows its deck above corrected ground",
    Math.abs(y - 0.55) < 0.001 &&
      world.terrain.heightAt(x, z) > 1 &&
      normal.distanceToSquared(new THREE.Vector3(0, 1, 0)) < 1e-10,
    `surface ${y.toFixed(2)}u, raw ${world.terrain.heightAt(x, z).toFixed(2)}u, normal ${normal
      .toArray()
      .map((n) => n.toFixed(3))
      .join(",")}`,
  );

  const solids = new SolidIndex(rest.solids);
  const ceilings = new CeilingIndex(deckCeilings(rest.decks));
  const carAt = (x: number, z: number, heading: number) => ({
    position: new THREE.Vector3(x, surface.heightAt(x, z) + 0.3, z),
    heading,
    speed: 0,
    forwardSpeed: 0,
    slip: 0,
    velAngle: null,
    steer: 0,
    isBoosting: false,
  });
  const view = (car: ReturnType<typeof carAt>): ChaseCamera => {
    const rig = new ChaseCamera(844 / 390);
    rig.setGround((x, z, y) => surface.floorBelow(x, z, y));
    rig.setCeilings(ceilings);
    rig.snapTo(car);
    for (let i = 0; i < 240; i++) rig.update(1 / 60, car, solids);
    rig.camera.updateMatrixWorld(true);
    return rig;
  };
  const downhill = carAt(-199.836, -260, -Math.PI / 2);
  const hill = view(downhill);
  const flat = carAt(-838.5, 452.4, 0);
  const widthRatio = pixelWidth(hill, downhill) / pixelWidth(view(flat), flat);
  check(
    "phone downhill framing preserves the taxi's apparent width",
    widthRatio >= 0.85 && widthRatio <= 1.3,
    `${(widthRatio * 100).toFixed(1)}% of flat-road width`,
  );
  const frameY = downhill.position.clone().project(hill.camera).y;
  check(
    "phone downhill taxi retains space below its wheels",
    frameY > -0.8 && frameY < 0,
    `${(((1 + frameY) * 390) / 2).toFixed(1)}px bottom margin`,
  );
  let clearance = Infinity;
  for (let i = 1; i <= 12; i++) {
    const point = downhill.position
      .clone()
      .add(new THREE.Vector3(0, CAMERA.lookHeight, 0))
      .lerp(hill.camera.position, i / 12);
    clearance = Math.min(
      clearance,
      point.y - surface.floorBelow(point.x, point.z, Math.max(point.y, downhill.position.y)),
    );
  }
  check(
    "shorter hill boom retains its entire terrain sightline",
    clearance >= 0.63,
    `${clearance.toFixed(3)}u minimum clearance`,
  );
  let step = 0;
  const before = new THREE.Vector3();
  for (let i = 0; i < 120; i++) {
    before.copy(hill.camera.position);
    downhill.position.x -= 0.1;
    downhill.position.y = surface.heightAt(downhill.position.x, downhill.position.z) + 0.3;
    hill.update(1 / 60, downhill, solids);
    step = Math.max(step, before.distanceTo(hill.camera.position));
  }
  check("hill framing changes smoothly while driving", step < 1, `${step.toFixed(3)}u max step`);
}

/** Camera terrain/bridge clearance, interrupted ribbons and boost release. */
export function checkDrivingFx(check: Check): void {
  const camera = new ChaseCamera(16 / 9);
  camera.setGround((_x, z) => -z);
  camera.snapTo({ heading: 0, position: new THREE.Vector3(0, 1.2, 0) });
  check(
    "downhill camera cut clears the uphill road behind the car",
    camera.camera.position.y >= -camera.camera.position.z + 0.6,
  );
  camera.setCeilings(new CeilingIndex([{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, y: 6 }]));
  camera.setGround(() => 6.8);
  camera.snapTo({ heading: 0, position: new THREE.Vector3(0, 1.2, 0) });
  check("overhead deck is never mistaken for the camera floor", camera.camera.position.y < 6);

  // Exercise the actual surface contract: heightAt intentionally selects a
  // bridge deck for traffic, while the camera needs the floor on its level.
  const network = new RoadNetwork([], []);
  const surface = new DriveSurface(
    new Terrain([], () => 1),
    { sizeX: 0, sizeZ: 0, cells: [], roads: [], buildingCells: [], greenCells: [] },
    () => network,
  );
  const ground = surface.heightAt(0, 0);
  surface.addDecks([
    { minX: -20, maxX: 20, minZ: -20, maxZ: 20, y: 6, y2: 10 },
    { minX: -20, maxX: 20, minZ: -20, maxZ: 20, y: 14 },
  ]);
  check(
    "camera below stacked bridges keeps the ground floor",
    surface.heightAt(0, 0) === 8 && surface.floorBelow(0, 0, 3) === ground,
  );
  check(
    "camera on a sloping bridge keeps that deck below the upper bridge",
    surface.floorBelow(0, -10, 8) === 7 && surface.floorBelow(0, 10, 10) === 9,
  );
  check(
    "camera above stacked bridges selects the highest eligible deck",
    surface.floorBelow(0, 0, 15) === 14,
  );
  check("camera floor stops at the bridge footprint", surface.floorBelow(20.01, 0, 15) === ground);
  camera.setGround((x, z, y) => surface.floorBelow(x, z, y));
  const ceilings = new CeilingIndex(deckCeilings(surface.getDecks()));
  camera.setCeilings(ceilings);
  camera.snapTo({ heading: 0, position: new THREE.Vector3(0, 1.2, 0) });
  const eye = camera.camera.position;
  check(
    "camera cut under a real sloping deck clears ground and soffit",
    eye.y >= ground + 0.6 && eye.y < ceilings.ceilingAt(eye.x, eye.z, 3),
  );

  // A convex crest blocks the boom's middle even after its endpoint has
  // cleared terrain. Keep the taxi framed while raising the whole sightline.
  const hill = new ChaseCamera(16 / 9);
  hill.setGround(hillHeight);
  const parked = {
    position: new THREE.Vector3(0, 1.2, 0),
    heading: 0,
    speed: 0,
    forwardSpeed: 0,
    slip: 0,
    velAngle: null,
    steer: 0,
    isBoosting: false,
  };
  hill.snapTo(parked);
  const solids = new SolidIndex([]);
  // The physics root settles near the asphalt. It is not the point the
  // camera needs to see: tracing from that root falsely blocks an otherwise
  // clear, flat underpass and retracts the eye into the taxi's rear roof.
  for (const rootHeight of [0.02, 0.1, 0.3]) {
    const underpass = new ChaseCamera(390 / 844);
    const car = { ...parked, position: new THREE.Vector3(0, rootHeight, 0) };
    underpass.setGround(() => 0);
    underpass.setCeilings(new CeilingIndex([{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, y: 4.2 }]));
    underpass.snapTo(car);
    for (let i = 0; i < 240; i++) underpass.update(1 / 60, car, solids);
    const eye = underpass.camera.position;
    const boom = Math.hypot(eye.x - car.position.x, eye.z - car.position.z);
    check(
      `low underpass keeps the taxi outside the camera at root ${rootHeight}u`,
      boom >= CAMERA.distance - 0.01 && eye.y >= 0.65 && eye.y <= 4.2 - CAMERA.ceilingClear + 0.01,
      `${boom.toFixed(2)}u boom, eye ${eye.y.toFixed(2)}u`,
    );
  }
  for (let i = 0; i < 240; i++) hill.update(1 / 60, parked, solids);
  const hillEye = hill.camera.position;
  check(
    "downhill camera keeps enough boom to frame the whole taxi",
    Math.hypot(hillEye.x - parked.position.x, hillEye.z - parked.position.z) >= 8,
  );
  let sightlineClearance = Infinity;
  for (let i = 1; i <= 12; i++) {
    const f = i / 12;
    const x = parked.position.x + (hillEye.x - parked.position.x) * f;
    const z = parked.position.z + (hillEye.z - parked.position.z) * f;
    const originY = parked.position.y + CAMERA.lookHeight;
    const y = originY + (hillEye.y - originY) * f;
    sightlineClearance = Math.min(sightlineClearance, y - hillHeight(x, z));
  }
  check(
    "downhill camera sightline clears the entire convex crest",
    sightlineClearance >= 0.64,
    `${sightlineClearance.toFixed(3)}u minimum clearance`,
  );
  const trails = new DriftTrails((x) => x * 0.4);
  trails.emit(0, 10, 10, 0, 1, 1);
  trails.emit(0, 10, 11, 0, 1, 1);
  trails.update(1 / 60);
  check(
    "consecutive contact patches make one ribbon segment",
    trails.mesh.geometry.drawRange.count === 6,
  );

  trails.break();
  trails.emit(0, 10, 12, 0, 1, 1);
  trails.update(1 / 60);
  check(
    "released drift does not reconnect a fading ribbon",
    trails.mesh.geometry.drawRange.count === 6,
  );
  trails.emit(0, 10, 13, 0, 1, 1);
  trails.update(1 / 60);
  check("new drift resumes with its own segment", trails.mesh.geometry.drawRange.count === 12);

  trails.emit(0, 800, 900, 0, 1, 1);
  trails.update(1 / 60);
  check(
    "teleport cannot stretch a ribbon across the city",
    trails.mesh.geometry.drawRange.count === 12,
  );

  const position = trails.mesh.geometry.getAttribute("position");
  const leftRise = position.getY(0) - position.getY(1);
  const slopeRise = (position.getX(0) - position.getX(1)) * 0.4;
  check("ribbon width follows a banked surface", Math.abs(leftRise - slopeRise) < 1e-5);
  trails.update(1);
  trails.update(0);
  check(
    "expired interrupted ribbons disappear",
    !trails.mesh.visible && trails.mesh.geometry.drawRange.count === 0,
  );

  const plume = new BoostPlume({ value: 1 });
  plume.drive(-0.55, 0.5, -2, 0.55, 0.5, -2, 0, 0, -1, 1);
  for (let i = 0; i < 60; i++) plume.update(1 / 60);
  const material = plume.mesh.material;
  if (!(material instanceof THREE.ShaderMaterial)) throw new Error("Boost plume lost its shader");
  const sustained = Number(material.uniforms.uIntensity?.value);
  plume.drive(-0.55, 0.5, -2, 0.55, 0.5, -2, 0, 0, -1, 0);
  let lastVisibleIntensity = 0;
  for (let i = 0; i < 90; i++) {
    plume.update(1 / 60);
    const intensity = Number(material.uniforms.uIntensity?.value);
    if (plume.mesh.visible) lastVisibleIntensity = intensity;
  }
  check(
    "boost plume fades below a tenth of burn before hiding",
    Number.isFinite(sustained) && lastVisibleIntensity < sustained * 0.1 && !plume.mesh.visible,
  );
}
