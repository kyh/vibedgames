import * as THREE from "three";

import {
  buildVessel,
  PORT_MATERIAL,
  PortBuilder,
  type Vessel,
  type VesselKind,
  WATER_Y,
} from "../world/watercraft";

import { blinkRate, GlowLayer } from "./beacon-lights";

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
type Lane = {
  readonly kind: VesselKind;
  readonly path: readonly (readonly [number, number])[];
  /** World units per second. Ships are slow; that is the point. */
  readonly speed: number;
  /** Seconds into the loop at t=0 — spaces same-kind vessels apart. */
  readonly phase: number;
  /** Seconds held at path[0] each lap (the ferry's berth at the terminal). */
  readonly dwell?: number;
  readonly seed: number;
};

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
    kind: "ferry",
    seed: 11,
    speed: 9,
    phase: 0,
    dwell: 18,
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
  },
  // Container feeder, southbound past the Embarcadero and under the western
  // crossing, then out to the horizon and back up. Clockwise; the tanker's
  // lane nests inside it, so the two can never cross.
  {
    kind: "container",
    seed: 23,
    speed: 11,
    phase: 0,
    path: [
      [1248, -1500],
      [1248, -1250],
      [1252, -900],
      [1250, -737], // the span between the centre anchorage and tower 2
      [1250, -300],
      [1310, -110],
      [1750, -110],
      [1750, -1560],
      [1310, -1560],
    ],
  },
  // Tanker, northbound through the span east of tower 2 (clear of Yerba
  // Buena's rock at x 1367-1445). Counter-clockwise, nested inside the feeder.
  {
    kind: "tanker",
    seed: 37,
    speed: 9,
    phase: 260,
    path: [
      [1340, -210],
      [1340, -737],
      [1340, -1430],
      [1650, -1430],
      [1650, -210],
    ],
  },
  // Two tugs working the Embarcadero: one south of the bridge, one off the
  // northern finger piers.
  {
    kind: "tug",
    seed: 41,
    speed: 5.5,
    phase: 0,
    path: [
      [1105, -690],
      [1185, -600],
      [1170, -460],
      [1095, -520],
    ],
  },
  {
    kind: "tug",
    seed: 43,
    speed: 5,
    phase: 40,
    path: [
      [1145, -1010],
      [1215, -930],
      [1190, -830],
      [1120, -900],
    ],
  },
  // Fireboat on patrol off the southern Embarcadero.
  {
    kind: "fireboat",
    seed: 47,
    speed: 6.5,
    phase: 0,
    path: [
      [1190, -400],
      [1265, -250],
      [1215, -70],
      [1140, -190],
      [1145, -320],
    ],
  },
  // The wharf fleet: three boats evenly spaced round one lane past Pier 45,
  // so they can never converge (same lane, same speed, thirds of a lap).
  {
    kind: "fishing",
    seed: 53,
    speed: 6,
    phase: 0,
    path: WHARF_LANE,
  },
  { kind: "fishing", seed: 59, speed: 6, phase: 60, path: WHARF_LANE },
  { kind: "fishing", seed: 61, speed: 6, phase: 120, path: WHARF_LANE },
  // Marina / Aquatic Park sailing: an inshore tack in the lee of the shore and
  // a longer one outside it, each with its boats spread round the lap.
  { kind: "sailboat", seed: 67, speed: 3.6, phase: 0, path: MARINA_INSHORE },
  { kind: "sailboat", seed: 71, speed: 3.6, phase: 122, path: MARINA_INSHORE },
  { kind: "sailboat", seed: 73, speed: 3.6, phase: 0, path: MARINA_OFFSHORE },
  { kind: "sailboat", seed: 79, speed: 3.6, phase: 122, path: MARINA_OFFSHORE },
  { kind: "sailboat", seed: 83, speed: 3.6, phase: 244, path: MARINA_OFFSHORE },
  // The kayak tour: one merged cluster on a slow paddle round Aquatic Park.
  {
    kind: "kayak",
    seed: 89,
    speed: 1.4,
    phase: 0,
    path: [
      [60, -1252],
      [140, -1284],
      [70, -1312],
      [-10, -1288],
    ],
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

// --- Wakes ----------------------------------------------------------------

const WAKE_LIFE = 7; // seconds a wake sample survives
const WAKE_STEP = 3; // world units between samples
const WAKE_SAMPLES = 22; // per vessel
const WAKE_LIFT = 0.06; // over the ocean plane
const WAKE_SPREAD = 3.4; // how much wider the ribbon gets by end of life
const WAKE_ALPHA = 0.5;
const WAKE_RANGE = 900; // past the fog there is nothing to see

type WakeSample = {
  x: number;
  z: number;
  /** Unit perpendicular captured at the time of the sample. */
  px: number;
  pz: number;
  half: number;
  age: number;
};

/**
 * One ribbon per vessel in a single dynamic buffer: white foam that widens and
 * fades astern. Normal-blended, not additive — wake is opaque froth on the
 * water, and additive white blows out over the bright bay.
 */
class Wakes {
  readonly mesh: THREE.Mesh;
  private readonly trails: WakeSample[][];
  private readonly heads: { x: number; z: number }[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly indices: Uint16Array;
  private readonly idxAttr: THREE.BufferAttribute;

  constructor(count: number) {
    this.trails = Array.from({ length: count }, () => []);
    this.heads = Array.from({ length: count }, () => ({ x: 0, z: 0 }));
    const maxVerts = count * WAKE_SAMPLES * 2;
    const maxTris = count * (WAKE_SAMPLES - 1) * 2;
    this.positions = new Float32Array(maxVerts * 3);
    this.colors = new Float32Array(maxVerts * 4);
    this.indices = new Uint16Array(maxTris * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.idxAttr = new THREE.BufferAttribute(this.indices, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.idxAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(this.idxAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false; // samples live in world space
    this.mesh.renderOrder = 1; // over the ocean, under the glow passes
  }

  /**
   * Feed one vessel's stern position. `half` is the ribbon's width at birth;
   * `live` false lets the existing wake age out without adding to it (a vessel
   * far from the camera, or one sitting at its berth).
   */
  push(i: number, x: number, z: number, dirX: number, dirZ: number, half: number, live: boolean) {
    const trail = this.trails[i];
    const head = this.heads[i];
    if (!trail || !head) return;
    if (!live) return;
    if (trail.length > 0 && Math.hypot(x - head.x, z - head.z) < WAKE_STEP) return;
    head.x = x;
    head.z = z;
    trail.push({ x, z, px: -dirZ, pz: dirX, half, age: 0 });
    if (trail.length > WAKE_SAMPLES) trail.shift();
  }

  update(dt: number): void {
    let v = 0;
    let idx = 0;
    for (const trail of this.trails) {
      // Samples are oldest-first, so age rises toward index 0: one scan finds
      // the cut, and the whole expired head goes in one splice.
      let cut = 0;
      for (let i = 0; i < trail.length; i++) {
        const s = trail[i];
        if (!s) continue;
        s.age += dt;
        if (s.age > WAKE_LIFE) cut = i + 1;
      }
      if (cut > 0) trail.splice(0, cut);
      const base = v / 3;
      for (let i = 0; i < trail.length; i++) {
        const s = trail[i];
        if (!s) continue;
        const k = s.age / WAKE_LIFE;
        const w = s.half * (1 + WAKE_SPREAD * k);
        // Newest sample is the churn at the stern: brightest, then it fades
        // with a soft head so the ribbon does not start with a hard edge.
        const a = (1 - k) ** 1.5 * WAKE_ALPHA * Math.min(1, i / 1.5 + 0.35);
        for (const side of [-1, 1] as const) {
          this.positions[v] = s.x + s.px * w * side;
          this.positions[v + 1] = WATER_Y + WAKE_LIFT;
          this.positions[v + 2] = s.z + s.pz * w * side;
          v += 3;
        }
        const ci = (v / 3 - 2) * 4;
        for (let c = 0; c < 2; c++) {
          this.colors[ci + c * 4] = 1;
          this.colors[ci + c * 4 + 1] = 1;
          this.colors[ci + c * 4 + 2] = 1;
          this.colors[ci + c * 4 + 3] = a;
        }
        if (i > 0) {
          const q = base + i * 2;
          this.indices[idx] = q - 2;
          this.indices[idx + 1] = q - 1;
          this.indices[idx + 2] = q;
          this.indices[idx + 3] = q - 1;
          this.indices[idx + 4] = q + 1;
          this.indices[idx + 5] = q;
          idx += 6;
        }
      }
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.idxAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, idx);
  }
}

// --- The fleet ------------------------------------------------------------

/** A lane resolved into a mesh plus its arc-length table. */
type Sailing = {
  readonly lane: Lane;
  readonly vessel: Vessel;
  readonly mesh: THREE.Mesh;
  /** Cumulative distance to each waypoint; last entry is the lap length. */
  readonly cum: readonly number[];
  yaw: number;
};

const NAV_RANGE = 520; // nav lights past this are a sub-pixel smudge
const BOB_RATE = 0.55;

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
      mesh.castShadow = false; // a shadow onto the ocean plane buys nothing
      const cum: number[] = [0];
      for (let i = 0; i < lane.path.length; i++) {
        const a = lane.path[i];
        const b = lane.path[(i + 1) % lane.path.length];
        if (!a || !b) continue;
        cum.push((cum[i] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      this.fleet.push({ lane, vessel, mesh, cum, yaw: 0 });
      this.group.add(mesh);
      lampCap += vessel.lights.length;
    }
    this.wakes = new Wakes(this.fleet.length);
    this.group.add(this.wakes.mesh);
    this.navLights = new GlowLayer({
      capacity: Math.max(1, lampCap),
      kind: "halo",
      alpha: 0.6,
      intensity: this.intensity,
      time: this.time,
    });
    this.group.add(this.navLights.mesh);
  }

  /** Night ramp, shared with every other lamp pass (0 = broad daylight). */
  setIntensity(night: number): void {
    this.intensity.value = night;
    this.navLights.mesh.visible = night > 0.01;
  }

  update(dt: number, camX: number, camZ: number): void {
    this.t += dt;
    this.time.value += dt;
    const lit = this.navLights.mesh.visible;
    if (lit) this.navLights.begin();
    for (let i = 0; i < this.fleet.length; i++) {
      const s = this.fleet[i];
      if (!s) continue;
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
      if (!lit || near > NAV_RANGE) continue;
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
    if (lit) this.navLights.commit();
    this.wakes.update(dt);
  }

  /** Advance one vessel along its lane. Returns false while it is berthed. */
  private place(s: Sailing, dt: number): boolean {
    const { lane, cum } = s;
    const lap = cum[cum.length - 1] ?? 1;
    const dwell = lane.dwell ?? 0;
    const cycle = lap / lane.speed + dwell;
    const local = (((this.t + lane.phase) % cycle) + cycle) % cycle;
    const berthed = local < dwell;
    const dist = berthed ? 0 : (local - dwell) * lane.speed;
    let seg = 0;
    while (seg + 1 < cum.length - 1 && (cum[seg + 1] ?? 0) <= dist) seg++;
    const a = lane.path[seg];
    const b = lane.path[(seg + 1) % lane.path.length];
    if (!a || !b) return false;
    const c0 = cum[seg] ?? 0;
    const c1 = cum[seg + 1] ?? c0 + 1;
    const t = c1 > c0 ? (dist - c0) / (c1 - c0) : 0;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    // Turn INTO the next leg rather than snapping at the waypoint; a 40u ship
    // pivoting on a corner is the tell that a path is a polyline.
    const target = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let d = target - s.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
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

/** Six kayaks in loose formation, merged so the tour costs ONE draw. */
function kayakRaft(seed: number): Vessel {
  const b = new PortBuilder();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  KAYAK_CLUSTER.forEach(([x, z, yaw], i) => {
    const k = buildVessel("kayak", seed + i);
    q.setFromAxisAngle(up, yaw);
    p.set(x, 0, z);
    b.addColored(k.geometry, m.compose(p, q, one));
  });
  const geometry = b.geometry();
  if (!geometry) throw new Error("kayak raft produced no geometry");
  return { geometry, lights: [], length: 9, wakeHalf: 2.4 };
}
