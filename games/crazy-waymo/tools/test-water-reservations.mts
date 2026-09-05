import { ModelCache } from "../src/assets/loader";
import { staticSolidBox } from "../src/physics/static-solid";
import type { Solid } from "../src/shared/types";
import type { CityRestPayload } from "../src/world/city";
import { buildLandmarks, landmarkProtection } from "../src/world/landmarks";
import { SolidIndex } from "../src/world/solid-index";
import { waterBodyContains, type WaterBody } from "../src/world/water";
import {
  carveWaterReservations,
  waterIntersectsReservation,
} from "../src/world/water-reservations";
import { landmarkReport, type AuditWorld } from "./geometry-audit.mts";

type Check = (name: string, passed: boolean, detail?: string) => void;

export function checkWaterReservations(
  check: Check,
  world: AuditWorld,
  rest?: CityRestPayload,
): void {
  const bodies: WaterBody[] = [];
  buildLandmarks(world.terrain, new ModelCache(), world.network, undefined, (b) => bodies.push(b));
  const reservations = landmarkProtection(world.plan, world.network).solids;
  const carved = carveWaterReservations(reservations, bodies);
  const decoded = carved.map((s) => ({
    ...s,
    minX: Math.fround(s.minX),
    maxX: Math.fround(s.maxX),
    minZ: Math.fround(s.minZ),
    maxZ: Math.fround(s.maxZ),
  }));
  const owned = landmarkReport([], decoded, world.network, world.plan, world.terrain);
  check(
    "landmark audit recognizes exact baked carved reservation ownership",
    owned.intruders.length === 0,
  );
  const exterior = carved.find((s) => s.maxX - s.minX > 4 && s.maxZ - s.minZ > 4);
  if (!exterior) throw new Error("Missing architectural reservation fixture");
  const foreign = landmarkReport(
    [],
    [...decoded, { ...exterior, minX: exterior.minX + 0.07 }],
    world.network,
    world.plan,
    world.terrain,
  );
  check(
    "landmark audit still rejects an unowned mass inside reserved land",
    foreign.intruders.length === 1,
  );
  const index = new SolidIndex(carved);
  check(
    "authored water removes generic reservations from every exact pool footprint",
    bodies.length === 5 &&
      bodies.every((body) => carved.every((box) => !waterIntersectsReservation(body, box))),
    `${reservations.length} reservations become ${carved.length} exterior boxes`,
  );
  let checked = 0,
    missing = 0;
  for (const box of reservations) {
    for (let x = box.minX + 0.2; x < box.maxX; x += 0.5)
      for (let z = box.minZ + 0.2; z < box.maxZ; z += 0.5) {
        // The expanded ellipse/rectangle conservatively excludes the small
        // boundary tolerance. Architectural ground outside it must still block.
        if (
          bodies.some((b) =>
            waterBodyContains({ ...b, halfX: b.halfX + 0.8, halfZ: b.halfZ + 0.8 }, x, z),
          )
        )
          continue;
        checked++;
        if (!index.hitAt(x, z)) missing++;
      }
  }
  check(
    "water carving retains surrounding architectural reservation coverage",
    checked > 1000 && missing === 0,
    `${checked} exterior probes, ${missing} missing`,
  );
  const small: Solid = { minX: -8, maxX: 8, minZ: -4, maxZ: 4 };
  const ellipse: WaterBody = {
    kind: "ellipse",
    x: 0,
    z: 0,
    y: 0,
    halfX: 3,
    halfZ: 1,
    yaw: Math.PI / 4,
  };
  const pieces = carveWaterReservations([small], [ellipse]);
  const rotated = new SolidIndex(pieces);
  check(
    "rotated pool subtraction retains monument corners while opening water",
    !rotated.hitAt(0, 0) && !!rotated.hitAt(7, 3) && !!rotated.hitAt(-7, -3) && pieces.length < 200,
  );
  if (!rest) return;
  const overlaps: string[] = [];
  for (const [i, body] of bodies.entries()) {
    for (const solid of rest.solids) {
      if (
        solid.noBody ||
        Math.hypot((solid.minX + solid.maxX) / 2 - body.x, (solid.minZ + solid.maxZ) / 2 - body.z) >
          60
      )
        continue;
      const box = staticSolidBox(solid, (x, z) => world.terrain.heightAt(x, z));
      if (body.y + 0.42 < box.y - box.hy || body.y + 0.42 > box.y + box.hy) continue;
      // Authored rims are outside this central hull-sized water area. The
      // historical obstruction was a full-height axis-aligned reservation.
      for (const [dx, dz] of [
        [0, 0],
        [-0.5, 0],
        [0.5, 0],
        [0, -0.5],
        [0, 0.5],
      ]) {
        if (dx === undefined || dz === undefined) continue;
        const c = Math.cos(body.yaw),
          s = Math.sin(body.yaw);
        const x = body.x + dx * body.halfX * c + dz * body.halfZ * s;
        const z = body.z - dx * body.halfX * s + dz * body.halfZ * c;
        const bx = x - box.x,
          bz = z - box.z,
          bc = Math.cos(box.yaw),
          bs = Math.sin(box.yaw);
        if (Math.abs(bx * bc - bz * bs) <= box.hx && Math.abs(bx * bs + bz * bc) <= box.hz) {
          overlaps.push(`pool${i}:${x.toFixed(2)},${z.toFixed(2)}`);
          break;
        }
      }
    }
  }
  check(
    "installed Palace and Sutro water contain no solid chassis obstruction",
    overlaps.length === 0,
    overlaps.slice(0, 5).join("; "),
  );
}
