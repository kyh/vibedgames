import * as THREE from "three";

import { buildVessel, PORT_MATERIAL, PortBuilder, WATER_Y } from "../world/watercraft";
import type { Vessel, VesselKind } from "../world/watercraft";

import { blinkRate } from "./beacon-lights";
import { GlowLayer } from "./glow-layer";
import { Wakes } from "./wakes";

// The bay's moving traffic: the Golden Gate ferry, a container ship and a
// tanker crossing under the Bay Bridge, working tugs, the fireboat, the wharf's
// fishing fleet, Marina sailboats and a kayak tour off Aquatic Park.
//
// Every vessel follows a CLOSED, hand-authored lane at constant speed, so the
// whole system is a pure function of elapsed time: no steering, no avoidance,
// no state to desync, and nothing that can wander onto the drivable world (the
// water is not drivable, and every lane below is verified to sit in open water
// clear of the pier polygons — see tools/, `pnpm test` covers the world grid,
// not this).
//
// Cost: one draw per vessel (frustum-culled, so ~0 when you are inland), plus
// ONE wake ribbon draw and ONE additive nav-light draw for the whole fleet.

/** Lane geometry: a closed polyline in world XZ. */
interface Lane {
  readonly kind: VesselKind;
  readonly path: readonly (readonly [number, number])[];
  /** World units per second. Ships are slow; that is the point. */
  readonly speed: number;
  /** Seconds into the loop at t=0 — spaces same-kind vessels apart. */
  readonly phase: number;
  /** Seconds held at path[0] each lap (the ferry's berth at the terminal). */
  readonly dwell?: number;
  readonly seed: number;
}

/** Lanes shared by several vessels — same lane, same speed, spread by phase. */
const WHARF_LANE: readonly (readonly [number, number])[] = [
  [300, -1330],
  [560, -1360],
  [760, -1440],
  [520, -1470],
  [260, -1420],
];
const MARINA_INSHORE: readonly (readonly [number, number])[] = [
  [-330, -1290],
  [-170, -1340],
  [-40, -1312],
  [-70, -1248],
  [-260, -1240],
];
const MARINA_OFFSHORE: readonly (readonly [number, number])[] = [
  [-330, -1420],
  [-100, -1480],
  [180, -1440],
  [0, -1390],
  [-260, -1385],
];

// Bay Bridge deck undersides sit at y≈8.3 (landmarks.ts BAY_DECK_Y 13, lower
// deck -4.2). The two ship lanes below thread the spans either side of the
// centre anchorage; watercraft.ts AIR_DRAFT_MAX keeps their masts under it.
export const HARBOR_LANES: readonly Lane[] = [
  // Golden Gate Ferry: berths at the Ferry Building, runs north out of the map
  // toward Sausalito, comes back. The dwell is the boarding stop.
  {
    dwell: 18,
    kind: "ferry",
    path: [
      [922, -866],
      [985, -960],
      [1035, -1120],
      [1050, -1330],
      [960, -1520],
      [830, -1490],
      [815, -1290],
      [860, -1080],
      [895, -955],
    ],
    phase: 0,
    seed: 11,
    speed: 9,
  },
  // Container feeder, southbound past the Embarcadero and under the western
  // crossing, then out to the horizon and back up. Clockwise; the tanker's
  // lane nests inside it, so the two can never cross.
  {
    kind: "container",
    path: [
      [1248, -1500],
      [1248, -1250],
      [1252, -900],
      // the span between the centre anchorage and tower 2
      [1250, -737],
      [1250, -300],
      [1310, -110],
      [1750, -110],
      [1750, -1560],
      [1310, -1560],
    ],
    phase: 0,
    seed: 23,
    speed: 11,
  },
  // Tanker, northbound through the span east of tower 2 (clear of Yerba
  // Buena's rock at x 1367-1445). Counter-clockwise, nested inside the feeder.
  {
    kind: "tanker",
    path: [
      [1340, -210],
      [1340, -737],
      [1340, -1430],
      [1650, -1430],
      [1650, -210],
    ],
    phase: 260,
    seed: 37,
    speed: 9,
  },
  // Two tugs working the Embarcadero: one south of the bridge, one off the
  // northern finger piers.
  {
    kind: "tug",
    path: [
      [1105, -690],
      [1185, -600],
      [1170, -460],
      [1095, -520],
    ],
    phase: 0,
    seed: 41,
    speed: 5.5,
  },
  {
    kind: "tug",
    path: [
      [1145, -1010],
      [1215, -930],
      [1190, -830],
      [1120, -900],
    ],
    phase: 40,
    seed: 43,
    speed: 5,
  },
  // Fireboat on patrol off the southern Embarcadero.
  {
    kind: "fireboat",
    path: [
      [1190, -400],
      [1265, -250],
      [1215, -70],
      [1140, -190],
      [1145, -320],
    ],
    phase: 0,
    seed: 47,
    speed: 6.5,
  },
  // The wharf fleet: three boats evenly spaced round one lane past Pier 45,
  // so they can never converge (same lane, same speed, thirds of a lap).
  {
    kind: "fishing",
    path: WHARF_LANE,
    phase: 0,
    seed: 53,
    speed: 6,
  },
  { kind: "fishing", path: WHARF_LANE, phase: 60, seed: 59, speed: 6 },
  { kind: "fishing", path: WHARF_LANE, phase: 120, seed: 61, speed: 6 },
  // Marina / Aquatic Park sailing: an inshore tack in the lee of the shore and
  // a longer one outside it, each with its boats spread round the lap.
  { kind: "sailboat", path: MARINA_INSHORE, phase: 0, seed: 67, speed: 3.6 },
  { kind: "sailboat", path: MARINA_INSHORE, phase: 122, seed: 71, speed: 3.6 },
  { kind: "sailboat", path: MARINA_OFFSHORE, phase: 0, seed: 73, speed: 3.6 },
  { kind: "sailboat", path: MARINA_OFFSHORE, phase: 122, seed: 79, speed: 3.6 },
  { kind: "sailboat", path: MARINA_OFFSHORE, phase: 244, seed: 83, speed: 3.6 },
  // The kayak tour: one merged cluster on a slow paddle round Aquatic Park.
  {
    kind: "kayak",
    path: [
      [60, -1252],
      [140, -1284],
      [70, -1312],
      [-10, -1288],
    ],
    phase: 0,
    seed: 89,
    speed: 1.4,
  },
];

/** Kayaks travel in a raft, so the cluster is baked into one moving mesh. */
const KAYAK_CLUSTER: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.4],
  [1.5, -2.2, -0.15],
  [-1.4, -2.6, 0.2],
  [0.4, -5.2, -0.3],
  [-2.2, -5.6, 0.5],
  [2.4, -6.4, 0],
];

// past the fog there is nothing to see
const WAKE_RANGE = 900;

// --- The fleet ------------------------------------------------------------

/** A lane resolved into a mesh plus its arc-length table. */
interface Sailing {
  readonly lane: Lane;
  readonly vessel: Vessel;
  readonly mesh: THREE.Mesh;
  /** Cumulative distance to each waypoint; last entry is the lap length. */
  readonly cum: readonly number[];
  yaw: number;
}

// nav lights past this are a sub-pixel smudge
const NAV_RANGE = 520;
const BOB_RATE = 0.55;

/** Six kayaks in loose formation, merged so the tour costs ONE draw. */
const kayakRaft = (seed: number): Vessel => {
  const b = new PortBuilder();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  for (const [i, [x, z, yaw]] of KAYAK_CLUSTER.entries()) {
    const k = buildVessel("kayak", seed + i);
    q.setFromAxisAngle(up, yaw);
    p.set(x, 0, z);
    b.addColored(k.geometry, m.compose(p, q, one));
  }
  const geometry = b.geometry();
  if (!geometry) {
    throw new Error("kayak raft produced no geometry");
  }
  return { geometry, length: 9, lights: [], wakeHalf: 2.4 };
};

export class Harbor {
  readonly group = new THREE.Group();
  private readonly fleet: Sailing[] = [];
  private readonly wakes: Wakes;
  private readonly navLights: GlowLayer;
  private readonly intensity = { value: 0 };
  private readonly time = { value: 0 };
  private readonly color = new THREE.Color();
  private t = 0;

  constructor() {
    let lampCap = 0;
    for (const lane of HARBOR_LANES) {
      const vessel =
        lane.kind === "kayak" ? kayakRaft(lane.seed) : buildVessel(lane.kind, lane.seed);
      const mesh = new THREE.Mesh(vessel.geometry, PORT_MATERIAL);
      // a shadow onto the ocean plane buys nothing
      mesh.castShadow = false;
      const cum: number[] = [0];
      for (let i = 0; i < lane.path.length; i += 1) {
        const a = lane.path[i];
        const b = lane.path[(i + 1) % lane.path.length];
        if (!a || !b) {
          continue;
        }
        cum.push((cum[i] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      this.fleet.push({ cum, lane, mesh, vessel, yaw: 0 });
      this.group.add(mesh);
      lampCap += vessel.lights.length;
    }
    this.wakes = new Wakes(this.fleet.length);
    this.group.add(this.wakes.mesh);
    this.navLights = new GlowLayer({
      alpha: 0.6,
      capacity: Math.max(1, lampCap),
      intensity: this.intensity,
      kind: "halo",
      time: this.time,
    });
    this.group.add(this.navLights.mesh);
  }

  /** Night ramp, shared with every other lamp pass (0 = broad daylight). */
  setIntensity(night: number): void {
    this.intensity.value = night;
    this.navLights.mesh.visible = night > 0.01;
    this.wakes.setNight(night);
  }

  update(dt: number, camX: number, camZ: number): void {
    this.t += dt;
    this.time.value += dt;
    const lit = this.navLights.mesh.visible;
    if (lit) {
      this.navLights.begin();
    }
    for (let i = 0; i < this.fleet.length; i += 1) {
      const s = this.fleet[i];
      if (!s) {
        continue;
      }
      const moving = this.place(s, dt);
      const p = s.mesh.position;
      const near = Math.hypot(p.x - camX, p.z - camZ);
      const dirX = Math.sin(s.yaw);
      const dirZ = Math.cos(s.yaw);
      this.wakes.push(
        i,
        p.x - dirX * s.vessel.length * 0.5,
        p.z - dirZ * s.vessel.length * 0.5,
        dirX,
        dirZ,
        s.vessel.wakeHalf,
        moving && near < WAKE_RANGE,
      );
      if (!lit || near > NAV_RANGE) {
        continue;
      }
      for (const l of s.vessel.lights) {
        this.navLights.push(
          p.x + l.x * dirZ + l.z * dirX,
          p.y + l.y,
          p.z - l.x * dirX + l.z * dirZ,
          this.color.setHex(l.color),
          l.size,
          blinkRate(l.blinkS),
        );
      }
    }
    if (lit) {
      this.navLights.commit();
    }
    this.wakes.update(dt);
  }

  /** Advance one vessel along its lane. Returns false while it is berthed. */
  private place(s: Sailing, dt: number): boolean {
    const { lane, cum } = s;
    const lap = cum.at(-1) ?? 1;
    const dwell = lane.dwell ?? 0;
    const cycle = lap / lane.speed + dwell;
    const local = (((this.t + lane.phase) % cycle) + cycle) % cycle;
    const berthed = local < dwell;
    const dist = berthed ? 0 : (local - dwell) * lane.speed;
    let seg = 0;
    while (seg + 1 < cum.length - 1 && (cum[seg + 1] ?? 0) <= dist) {
      seg += 1;
    }
    const a = lane.path[seg];
    const b = lane.path[(seg + 1) % lane.path.length];
    if (!a || !b) {
      return false;
    }
    const c0 = cum[seg] ?? 0;
    const c1 = cum[seg + 1] ?? c0 + 1;
    const t = c1 > c0 ? (dist - c0) / (c1 - c0) : 0;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    // Turn INTO the next leg rather than snapping at the waypoint; a 40u ship
    // pivoting on a corner is the tell that a path is a polyline.
    const target = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let d = target - s.yaw;
    while (d > Math.PI) {
      d -= Math.PI * 2;
    }
    while (d < -Math.PI) {
      d += Math.PI * 2;
    }
    s.yaw += d * Math.min(1, dt * 0.6);
    const bob = Math.sin(this.t * BOB_RATE + lane.seed) * 0.09;
    s.mesh.position.set(x, WATER_Y + bob * 0.6, z);
    s.mesh.rotation.set(
      Math.sin(this.t * 0.41 + lane.seed) * 0.012,
      s.yaw,
      Math.sin(this.t * 0.33 + lane.seed * 1.7) * 0.02,
    );
    return !berthed;
  }
}
