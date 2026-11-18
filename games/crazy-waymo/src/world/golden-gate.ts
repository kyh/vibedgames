import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { BRIDGE_PILLAR_WIDE, modelUrl, PARK_TREES, ROAD_BRIDGE } from "../assets/manifest";
import type { Beacon } from "../fx/beacon-lights";
import { GRID_X, GRID_Z, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import { seatMasonry } from "./masonry";
import type { CityPlan } from "./grid";
import type { Solid, SurfaceDeck } from "./city";
import type { Terrain } from "./terrain";

const DECK_Y = 7;
const DECK_W = 10;
const RAMP_LEN = 26;
const RAIL_T = 0.8;
const BOARD_SCALE_Y = 1.6;
const TOWER_H = 44;
const LAMP_H = 2.4;
const LEG_OFF = 2.6;
const LEG_BASE = 4.4;
const LEG_TOP = 2.8;
const LEG_BASE_Y = -7;
const LEG_DEPTH = 1.55;
const legWidthAt = (t: number) => THREE.MathUtils.lerp(LEG_BASE, LEG_TOP, t);
const braceLift = (t: number) => 1 - (1 - t) ** 1.45;
const TOWER_STEPS = 4;
const CABLE_LOW = 5;
const APPROACH_U_MIN = 0.19;
const APPROACH_U_MAX = 0.35;

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xc0_36_2c, roughness: 0.6 });
const RAIL_ORANGE = new THREE.MeshStandardMaterial({ color: 0xa9_32_27, roughness: 0.7 });
const TOWER_LAMP = new THREE.MeshBasicMaterial({ color: 0xff_d9_a0, toneMapped: false });

const jit = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43_758.5453;

  return s - Math.floor(s);
};

/** Everything the placement solve needs — no model cache, so it is callable
 * from the baked-bin load path where no geometry is being built. */
export interface GoldenGatePlanCtx {
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  readonly worldX: (gx: number) => number;
  readonly worldZ: (gz: number) => number;
}

export type GoldenGateCtx = GoldenGatePlanCtx & {
  readonly cache: ModelCache;
};

export interface GoldenGateResult {
  readonly objects: THREE.Object3D[];
  readonly solids: Solid[];
  readonly decks: readonly SurfaceDeck[];
}

export interface GoldenGatePlan {
  readonly ax: number;
  readonly anchorGx: number;
  readonly anchorGz: number;
  readonly shoreZ: number;
  readonly shoreH: number;
  readonly endZ: number;
  readonly rampLen: number;
  readonly rampTopZ: number;
  readonly kneeZ: number;
  readonly kneeY: number;
  readonly deckY: number;
  readonly half: number;
  readonly landfallZ: number | null;
  readonly northEndZ: number;
  readonly railMinZ: number;
  readonly railMaxZ: number;
  /** North (Marin) tower. */
  readonly towerZ: number;
  /** South (Presidio) tower — the pair is what makes the bridge readable. */
  readonly towerZ2: number;
  readonly topY: number;
}

let solvedPlan: GoldenGatePlan | null = null;

/** The bridge as the running world placed it, or null before the world loads. */
export const goldenGateSolvedPlan = () => solvedPlan;

const rampProfile = (plan: GoldenGatePlan, t: number) => {
  const tc = THREE.MathUtils.clamp(t, 0, 1);

  return tc < 0.68
    ? THREE.MathUtils.lerp(plan.shoreH, plan.kneeY, tc / 0.68)
    : THREE.MathUtils.lerp(plan.kneeY, plan.deckY, (tc - 0.68) / 0.32);
};

const southAnchor = (plan: GoldenGatePlan) => ({
  y: plan.deckY + 4.6,
  z: plan.shoreZ + 3,
});

const northAnchor = (plan: GoldenGatePlan) => {
  const main = plan.towerZ2 - plan.towerZ;

  return {
    y: Math.max(plan.deckY + 7, plan.topY - main * 0.24),
    z: plan.northEndZ - 14,
  };
};

const cableSaddles = (plan: GoldenGatePlan) => {
  const s = southAnchor(plan);
  const n = northAnchor(plan);

  return [
    [s.z, s.y, 2.6],
    [plan.towerZ2, plan.topY, plan.topY - (plan.deckY + CABLE_LOW)],
    [plan.towerZ, plan.topY, 2.4],
    [n.z, n.y, 0],
  ] as const;
};

const cableY = (saddles: readonly (readonly [number, number, number])[], z: number) => {
  for (let i = 0; i < saddles.length - 1; i += 1) {
    const a = saddles[i];
    const b = saddles[i + 1];

    if (!a || !b) {
      continue;
    }

    const [az, ay, sag] = a;
    const [bz, by] = b;

    if (z > az || z < bz) {
      continue;
    }

    const t = (az - z) / (az - bz);

    return ay + (by - ay) * t - 4 * sag * t * (1 - t);
  }

  return null;
};

/**
 * Solve the bridge's placement. Cheap — one grid scan plus arithmetic, no
 * meshes — so both the cold-gen path and the baked-bin path can call it.
 * Null when the Presidio coast road the ramp needs does not exist.
 */
export const goldenGatePlan = (ctx: GoldenGatePlanCtx) => {
  let anchor: { gx: number; gz: number } | null = null;

  for (let gx = 0; gx < GRID_X; gx += 1) {
    const wx = ctx.worldX(gx);
    const u = wx / WORLD_W + 0.5;

    if (u < APPROACH_U_MIN || u > APPROACH_U_MAX) {
      continue;
    }

    for (let gz = 8; gz < GRID_Z; gz += 1) {
      if (ctx.plan.cells[gx]?.[gz] !== "road") {
        continue;
      }

      if (!anchor || gz < anchor.gz) {
        anchor = { gx, gz };
      }

      break;
    }
  }

  if (!anchor) {
    solvedPlan = null;

    return null;
  }

  const ax = ctx.worldX(anchor.gx);
  const shoreZ = ctx.worldZ(anchor.gz);
  const shoreH = ctx.terrain.heightAt(ax, shoreZ) + 0.04;
  const endZ = -WORLD_HALF_Z + 3.5;
  const span = shoreZ - endZ;
  const rampLen = THREE.MathUtils.clamp(span * 0.6, 10, RAMP_LEN);
  const deckY = Math.min(DECK_Y, shoreH + rampLen * 0.36);
  const rampTopZ = shoreZ - rampLen;
  const kneeZ = shoreZ - rampLen * 0.68;
  const kneeY = shoreH + (deckY - shoreH) * 0.8;

  let landfallZ: number | null = null;

  for (let z = rampTopZ - 8; z >= -WORLD_HALF_Z + 6; z -= 2) {
    if (ctx.terrain.heightAt(ax, z) >= deckY - 0.2) {
      landfallZ = z;
      break;
    }
  }

  const northEndZ = landfallZ ?? endZ;
  const towerZ = landfallZ === null ? -WORLD_HALF_Z + 14 : Math.min(landfallZ + 18, rampTopZ - 10);

  const towerZ2 = Math.min(
    rampTopZ - 8,
    Math.max(towerZ + 30, rampTopZ - (rampTopZ - towerZ) * 0.14),
  );

  solvedPlan = {
    anchorGx: anchor.gx,
    anchorGz: anchor.gz,
    ax,
    deckY,
    endZ,
    half: DECK_W / 2,
    kneeY,
    kneeZ,
    landfallZ,
    northEndZ,
    railMaxZ: shoreZ - 1,
    railMinZ: landfallZ === null ? endZ : landfallZ - 1,
    rampLen,
    rampTopZ,
    shoreH,
    shoreZ,
    topY: deckY + TOWER_H,
    towerZ,
    towerZ2,
  };

  return solvedPlan;
};

const lampStations = (plan: GoldenGatePlan) => {
  const out: { x: number; y: number; z: number }[] = [];
  const span = plan.railMaxZ - plan.railMinZ;
  const n = Math.max(2, Math.round(span / 11));

  for (let i = 0; i < n; i += 1) {
    const lz = plan.railMaxZ - (span * (i + 0.5)) / n;

    const ly =
      lz > plan.rampTopZ ? rampProfile(plan, (plan.shoreZ - lz) / plan.rampLen) : plan.deckY;

    for (const sx of [-(plan.half + RAIL_T / 2), plan.half + RAIL_T / 2]) {
      out.push({ x: plan.ax + sx, y: ly, z: lz });
    }
  }

  return out;
};

/**
 * Night lights for the bridge — warm deck string plus red aviation beacons on
 * the tower tops. Same colours as the Bay Bridge (landmarks.ts) so the two
 * crossings read as one city after dark.
 */
export const goldenGateBeacons = (plan: GoldenGatePlan) => {
  const beacons: Beacon[] = [];

  for (const tz of [plan.towerZ, plan.towerZ2]) {
    for (const sx of [-(plan.half + LEG_OFF), plan.half + LEG_OFF]) {
      beacons.push({
        blinkS: 2.6,
        color: 0xff_44_36,
        size: 3.4,
        x: plan.ax + sx,
        y: plan.topY + 1.6,
        z: tz,
      });

      for (let i = 1; i <= 4; i += 1) {
        const wy = plan.deckY + (TOWER_H * i) / 4.6;
        beacons.push({ color: 0xff_b0_66, size: 5.2, x: plan.ax + sx, y: wy, z: tz });
      }
    }
  }

  for (const st of lampStations(plan)) {
    beacons.push({
      color: 0xff_d9_a0,
      groundY: st.y + 0.05,
      size: 2.1,
      x: st.x,
      y: st.y + LAMP_H,
      z: st.z,
    });
  }

  return beacons;
};

/** One member of the long-range silhouette: a segment with a half-thickness. */
export interface SilhouetteBar {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly halfA: number;
  readonly halfB: number;
  /**
   * Share of the minimum SCREEN width this member holds at range (1 = a tower
   * leg). Not every member is worth the same number of pixels: give the deck
   * chords a tower's floor and the two of them fuse into a slab three times the
   * truss's real depth, and the crossing reads as a luggage handle. The tower
   * carries the silhouette, so it holds the most.
   */
  readonly minScale: number;
}

const SIL_INSET = 0.8;

/**
 * The bridge reduced to ~70 bars — both towers, their portal bracing, the deck
 * truss chords and the two main cables — for the long-range silhouette that
 * render/far-terrain.ts draws. Data only: no meshes, no model cache, so the
 * baked load path (where `buildGoldenGate` never runs) can build it too.
 *
 * Why it exists: past DETAIL_DISTANCE the city keeps a box imposter only for
 * instances 13u or taller, which on this bridge is the four tower legs and
 * nothing else. The cables, the truss, the deck and the bracing are all gone by
 * 440u — measured at 700u the crossing is four orange sticks with no form, at
 * 1200u a grey smudge, at 2000u nothing. A landmark you steer by cannot be the
 * one thing that disappears from the far half of the map.
 */
export const goldenGateSilhouette = (plan: GoldenGatePlan) => {
  const bars: SilhouetteBar[] = [];

  const add = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    minScale: number,
    halfA: number,
    halfB = halfA,
  ) => {
    bars.push({ a, b, halfA: halfA * SIL_INSET, halfB: halfB * SIL_INSET, minScale });
  };

  const legX = plan.half + LEG_OFF;

  const legHalf = (y: number) =>
    legWidthAt(THREE.MathUtils.clamp((y - LEG_BASE_Y) / (plan.topY - LEG_BASE_Y), 0, 1)) / 2;

  const kneeY = plan.deckY + (plan.topY - plan.deckY) * 0.45;

  for (const tz of [plan.towerZ, plan.towerZ2]) {
    for (const sx of [-legX, legX]) {
      const x = plan.ax + sx;
      add(
        new THREE.Vector3(x, 0, tz),
        new THREE.Vector3(x, kneeY, tz),
        1,
        legHalf(0),
        legHalf(kneeY),
      );
      add(
        new THREE.Vector3(x, kneeY, tz),
        new THREE.Vector3(x, plan.topY + 0.4, tz),
        1,
        legHalf(kneeY),
        legHalf(plan.topY),
      );
      const capY = plan.topY + 1.1;
      const capX = (LEG_TOP + 2.1) / 2;
      const capZ = (LEG_TOP * LEG_DEPTH + 2.1) / 2;
      add(new THREE.Vector3(x - capX, capY, tz), new THREE.Vector3(x + capX, capY, tz), 0.8, 0.72);
      add(new THREE.Vector3(x, capY, tz - capZ), new THREE.Vector3(x, capY, tz + capZ), 0.8, 0.72);
    }

    for (const i of [0, 2, 4] as const) {
      const by = THREE.MathUtils.lerp(plan.deckY + 8, plan.topY - 3.4, braceLift(i / 4));
      add(
        new THREE.Vector3(plan.ax - legX, by, tz),
        new THREE.Vector3(plan.ax + legX, by, tz),
        0.55,
        0.75,
      );
    }

    add(
      new THREE.Vector3(plan.ax - legX, plan.topY + 0.35, tz),
      new THREE.Vector3(plan.ax + legX, plan.topY + 0.35, tz),
      0.6,
      0.42,
    );
  }

  const trussZ0 = plan.northEndZ - 1.4;
  const trussZ1 = plan.rampTopZ;
  const chordSides = [-(plan.half + RAIL_T / 2), plan.half + RAIL_T / 2] as const;
  const chordDrops = [0.55, 2.85] as const;

  for (const sx of chordSides) {
    for (const drop of chordDrops) {
      add(
        new THREE.Vector3(plan.ax + sx, plan.deckY - drop, trussZ0),
        new THREE.Vector3(plan.ax + sx, plan.deckY - drop, trussZ1),
        0.3,
        0.4,
      );
    }
  }

  {
    const rampEndZ = plan.shoreZ - 2.2;
    const steps = 4;

    for (const sx of chordSides) {
      for (const drop of chordDrops) {
        for (let i = 0; i < steps; i += 1) {
          const z0 = THREE.MathUtils.lerp(trussZ1, rampEndZ, i / steps);
          const z1 = THREE.MathUtils.lerp(trussZ1, rampEndZ, (i + 1) / steps);
          const y0 = rampProfile(plan, (plan.shoreZ - z0) / plan.rampLen) - drop * (1 - i / steps);

          const y1 =
            rampProfile(plan, (plan.shoreZ - z1) / plan.rampLen) - drop * (1 - (i + 1) / steps);

          add(
            new THREE.Vector3(plan.ax + sx, y0, z0),
            new THREE.Vector3(plan.ax + sx, y1, z1),
            0.3,
            0.4,
          );
        }
      }
    }
  }

  const saddles = cableSaddles(plan);
  const z0 = saddles[0]?.[0] ?? plan.shoreZ;
  const z1 = saddles.at(-1)?.[0] ?? plan.northEndZ;
  const steps = 40;

  for (const sx of [-legX, legX]) {
    let prev: THREE.Vector3 | null = null;

    for (let i = 0; i <= steps; i += 1) {
      const cz = z0 - ((z0 - z1) * i) / steps;
      const cy = cableY(saddles, cz);

      if (cy === null) {
        prev = null;
        continue;
      }

      const p = new THREE.Vector3(plan.ax + sx, cy, cz);

      if (prev) {
        add(prev, p, 0.28, 0.14);
      }

      prev = p;
    }
  }

  return bars;
};

const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  m.updateMatrixWorld(true);

  return m;
};

interface Build {
  readonly ctx: GoldenGateCtx;
  readonly plan: GoldenGatePlan;
  readonly objects: THREE.Object3D[];
  readonly solids: Solid[];
}

const planDecks = (ctx: GoldenGateCtx, plan: GoldenGatePlan) => {
  const decks: SurfaceDeck[] = [];
  const { ax, shoreZ, shoreH, rampTopZ, kneeZ, kneeY, deckY, half, landfallZ, northEndZ } = plan;
  decks.push(
    { maxX: ax + half, maxZ: shoreZ, minX: ax - half, minZ: kneeZ, y: kneeY, y2: shoreH },
    {
      maxX: ax + half,
      maxZ: kneeZ,
      minX: ax - half,
      minZ: rampTopZ,
      y: deckY,
      y2: kneeY,
    },
  );
  let spanMinZ = northEndZ - 4;

  if (landfallZ !== null) {
    const blendTopZ = landfallZ - 18;
    const blendTopY = ctx.terrain.heightAt(ax, blendTopZ) + 0.05;

    if (blendTopY > deckY) {
      spanMinZ = landfallZ + 8;
      decks.push({
        maxX: ax + half,
        maxZ: landfallZ + 8,
        minX: ax - half,
        minZ: blendTopZ,
        y: blendTopY,
        y2: deckY,
      });
    }
  }

  decks.push({ maxX: ax + half, maxZ: rampTopZ, minX: ax - half, minZ: spanMinZ, y: deckY });

  return decks;
};

const buildDeckBoards = ({ ctx, objects, plan }: Build) => {
  const { ax, shoreZ, rampLen, rampTopZ, deckY, landfallZ, northEndZ } = plan;
  const deckUrl = modelUrl("roads", ROAD_BRIDGE);
  const db = ctx.cache.bounds(deckUrl);
  const segLen = 8;
  const boardScaleX = (DECK_W + 1.6) / Math.max(db.size.x, 0.001);
  const boardScaleZ = segLen / Math.max(db.size.z, 0.001);
  const boardTop = BOARD_SCALE_Y * (db.min.y + db.size.y);
  const rampSegs = Math.ceil(rampLen / 4);
  const rampSegLen = rampLen / rampSegs;

  for (let i = 0; i < rampSegs; i += 1) {
    const t0 = i / rampSegs;
    const t1 = (i + 1) / rampSegs;
    const h0 = rampProfile(plan, t0);
    const h1 = rampProfile(plan, t1);
    const pitch = Math.atan((h1 - h0) / rampSegLen);
    const seg = ctx.cache.instance(deckUrl);
    seg.scale.set(
      boardScaleX,
      BOARD_SCALE_Y,
      rampSegLen / Math.max(db.size.z, 0.001) / Math.cos(pitch),
    );
    seg.position.set(ax, (h0 + h1) / 2 - boardTop, shoreZ - rampSegLen * (i + 0.5));
    seg.rotation.x = pitch;
    seg.updateMatrixWorld(true);
    objects.push(seg);
  }

  for (let z = rampTopZ; z > northEndZ - segLen; z -= segLen) {
    const seg = ctx.cache.instance(deckUrl);
    seg.scale.set(boardScaleX, BOARD_SCALE_Y, boardScaleZ);
    seg.position.set(ax, deckY - boardTop, z - segLen / 2);
    seg.updateMatrixWorld(true);
    objects.push(seg);
  }

  if (landfallZ !== null) {
    const blendTopZ = landfallZ - 18;
    const blendTopY = ctx.terrain.heightAt(ax, blendTopZ) + 0.05;

    if (blendTopY > deckY) {
      const runLen = landfallZ + 8 - blendTopZ;
      const pitch = Math.atan((blendTopY - deckY) / runLen);
      const nSegs = Math.ceil(runLen / 6);
      const segZ = runLen / nSegs;

      for (let i = 0; i < nSegs; i += 1) {
        const zMid = landfallZ + 8 - segZ * (i + 0.5);
        const t = (landfallZ + 8 - zMid) / runLen;
        const seg = ctx.cache.instance(deckUrl);
        seg.scale.set(
          boardScaleX,
          BOARD_SCALE_Y,
          segZ / Math.max(db.size.z, 0.001) / Math.cos(pitch),
        );
        seg.position.set(ax, deckY + (blendTopY - deckY) * t - boardTop, zMid);
        seg.rotation.x = pitch;
        seg.updateMatrixWorld(true);
        objects.push(seg);
      }
    }
  }

  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR_WIDE);
  const pb = ctx.cache.bounds(pillarUrl);
  {
    const p = ctx.cache.instance(pillarUrl);
    p.scale.set(
      (DECK_W + 2) / Math.max(pb.size.x, 0.001),
      (deckY + 0.5) / Math.max(pb.size.y, 0.001),
      4 / Math.max(pb.size.z, 0.001),
    );
    p.position.set(ax, -0.6, rampTopZ - 6);
    p.updateMatrixWorld(true);
    objects.push(p);
  }
};

const buildLampPosts = ({ objects, plan }: Build) => {
  const postGeo = new THREE.BoxGeometry(0.16, LAMP_H, 0.16);
  const headGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);

  for (const st of lampStations(plan)) {
    objects.push(
      mesh(postGeo, RAIL_ORANGE, st.x, st.y + LAMP_H / 2, st.z),
      mesh(headGeo, RAIL_ORANGE, st.x, st.y + LAMP_H, st.z),
    );
  }
};

const buildTruss = ({ objects, plan }: Build) => {
  const { ax, shoreZ, rampLen, rampTopZ, deckY, half, northEndZ } = plan;
  const trussZ0 = northEndZ - 2;
  const trussZ1 = rampTopZ;
  const spanLen = trussZ1 - trussZ0;
  const chord = new THREE.BoxGeometry(1, 0.8, spanLen);
  const sides = [-(half + RAIL_T / 2), half + RAIL_T / 2] as const;

  for (const sx of sides) {
    for (const cy of [deckY - 0.55, deckY - 2.85]) {
      objects.push(mesh(chord, ORANGE, ax + sx, cy, (trussZ0 + trussZ1) / 2));
    }
  }

  const panels = Math.max(4, Math.round(spanLen / 7.5));
  const panelLen = spanLen / panels;
  const post = new THREE.BoxGeometry(0.55, 2.3, 0.55);
  const beam = new THREE.BoxGeometry(DECK_W + RAIL_T * 2, 0.55, 0.55);
  const diagLen = Math.hypot(panelLen, 2.3);
  const diag = new THREE.BoxGeometry(0.4, diagLen, 0.4);
  const diagTilt = Math.atan2(panelLen, 2.3);

  for (let i = 0; i <= panels; i += 1) {
    const bz = trussZ1 - panelLen * i;

    for (const sx of sides) {
      objects.push(mesh(post, ORANGE, ax + sx, deckY - 1.7, bz));
    }

    if (i === panels) {
      continue;
    }

    objects.push(mesh(beam, ORANGE, ax, deckY - 2.85, bz - panelLen / 2));

    for (const sx of sides) {
      const d = mesh(diag, ORANGE, ax + sx, deckY - 1.7, bz - panelLen / 2);
      d.rotation.x = i % 2 === 0 ? diagTilt : -diagTilt;
      d.updateMatrixWorld(true);
      objects.push(d);
    }
  }

  const rampEndZ = shoreZ - 2.2;
  const rampPanels = 7;

  for (let i = 0; i < rampPanels; i += 1) {
    const f0 = i / rampPanels;
    const f1 = (i + 1) / rampPanels;
    const z0 = THREE.MathUtils.lerp(trussZ1, rampEndZ, f0);
    const z1 = THREE.MathUtils.lerp(trussZ1, rampEndZ, f1);
    const y0 = rampProfile(plan, (shoreZ - z0) / rampLen) - 0.55;
    const y1 = rampProfile(plan, (shoreZ - z1) / rampLen) - 0.55;
    const run = z1 - z0;
    const pitch = Math.atan2(y1 - y0, run);
    const len = Math.hypot(run, y1 - y0);
    const depth = THREE.MathUtils.lerp(2.3, 0.4, (f0 + f1) / 2);
    const rampChord = new THREE.BoxGeometry(1, 0.8, len + 0.3);
    const web = new THREE.BoxGeometry(0.5, depth, 0.5);

    for (const sx of sides) {
      for (const drop of [0, -depth]) {
        const c = mesh(rampChord, ORANGE, ax + sx, (y0 + y1) / 2 + drop, (z0 + z1) / 2);
        c.rotation.x = -pitch;
        c.updateMatrixWorld(true);
        objects.push(c);
      }

      objects.push(mesh(web, ORANGE, ax + sx, y0 - depth / 2, z0));
    }
  }
};

const buildTowers = ({ objects, plan }: Build) => {
  const { ax, deckY, half, towerZ, towerZ2, topY } = plan;
  const legX = half + LEG_OFF;
  const legBaseY = LEG_BASE_Y;
  const secH = (topY - legBaseY) / TOWER_STEPS;
  const markerGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const capGeo = new THREE.BoxGeometry(LEG_TOP + 2.1, 0.7, LEG_TOP * LEG_DEPTH + 2.1);
  const saddleGeo = new THREE.BoxGeometry(LEG_TOP + 0.9, 1.5, LEG_TOP * LEG_DEPTH + 0.9);

  for (const tz of [towerZ2, towerZ]) {
    for (const sx of [-legX, legX]) {
      for (let i = 0; i < TOWER_STEPS; i += 1) {
        const y0 = legBaseY + secH * i;
        const w = legWidthAt((i + 0.5) / TOWER_STEPS);
        const d = w * LEG_DEPTH;
        objects.push(mesh(new THREE.BoxGeometry(w, secH, d), ORANGE, ax + sx, y0 + secH / 2, tz));

        if (i > 0) {
          objects.push(
            mesh(new THREE.BoxGeometry(w + 0.55, 0.42, d + 0.55), ORANGE, ax + sx, y0, tz),
          );
        }

        for (const fz of [-1, 1] as const) {
          for (const off of [-w * 0.26, w * 0.26]) {
            objects.push(
              mesh(
                new THREE.BoxGeometry(w * 0.19, secH - 0.9, 0.24),
                ORANGE,
                ax + sx + off,
                y0 + secH / 2,
                tz + (fz * d) / 2,
              ),
            );
          }
        }

        for (const fx of [-1, 1] as const) {
          objects.push(
            mesh(
              new THREE.BoxGeometry(0.24, secH - 0.9, d * 0.22),
              ORANGE,
              ax + sx + (fx * w) / 2,
              y0 + secH / 2,
              tz,
            ),
          );
        }
      }

      objects.push(
        mesh(capGeo, ORANGE, ax + sx, topY + 0.35, tz),
        mesh(saddleGeo, ORANGE, ax + sx, topY + 1.45, tz),
      );

      for (let i = 0; i < 7; i += 1) {
        const my = deckY + 3 + (i * (TOWER_H - 5)) / 6;
        objects.push(mesh(markerGeo, TOWER_LAMP, ax + sx + Math.sign(sx) * 1.3, my, tz));
      }
    }

    for (let i = 0; i < 5; i += 1) {
      const t = braceLift(i / 4);
      const by = THREE.MathUtils.lerp(deckY + 8, topY - 3.4, t);
      const w = legX * 2 + legWidthAt((by - legBaseY) / (topY - legBaseY)) - t * 1.6;
      objects.push(
        mesh(new THREE.BoxGeometry(w, 1.5, 1.9), ORANGE, ax, by, tz),
        mesh(new THREE.BoxGeometry(w - 3.2, 0.8, 1.45), ORANGE, ax, by - 1.1, tz),
        mesh(new THREE.BoxGeometry(w - 1.6, 0.7, 1.6), ORANGE, ax, by + 1.05, tz),
      );
    }

    objects.push(
      mesh(
        new THREE.BoxGeometry(legX * 2 + LEG_TOP - 0.4, 0.85, LEG_TOP * LEG_DEPTH + 0.4),
        ORANGE,
        ax,
        topY + 0.35,
        tz,
      ),
      mesh(new THREE.BoxGeometry(legX * 2 + LEG_BASE, 1.3, 2.1), ORANGE, ax, deckY - 3.6, tz),
    );
    const fenderW = legX * 2 + LEG_BASE + 2.4;
    const fenderD = LEG_BASE * LEG_DEPTH + 5.4;
    objects.push(
      seatMasonry({
        batter: 0.1,
        d: fenderD + 0.7,
        h: 4.4,
        seed: tz,
        w: fenderW + 0.7,
        x: ax,
        y: -2.8,
        z: tz,
      }),
    );
  }
};

const buildCables = ({ objects, plan }: Build) => {
  const { ax, shoreZ, deckY, half, northEndZ, railMinZ, railMaxZ } = plan;
  const legX = half + LEG_OFF;
  const saddles = cableSaddles(plan);
  const cableZ0 = saddles[0]?.[0] ?? shoreZ;
  const cableZ1 = saddles.at(-1)?.[0] ?? northEndZ;
  const ropeGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
  const linkGeo = new THREE.BoxGeometry(0.5, 1, 0.5);

  for (const sx of [-legX, legX]) {
    const pts: THREE.Vector3[] = [];
    const steps = Math.max(24, Math.round((cableZ0 - cableZ1) / 2.5));

    for (let i = 0; i <= steps; i += 1) {
      const cz = cableZ0 - ((cableZ0 - cableZ1) * i) / steps;
      const cy = cableY(saddles, cz);

      if (cy !== null) {
        pts.push(new THREE.Vector3(ax + sx, cy, cz));
      }
    }

    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];

      if (!a || !b) {
        continue;
      }

      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len = Math.hypot(dy, dz);

      if (len < 0.001) {
        continue;
      }

      const link = mesh(linkGeo, ORANGE, a.x, (a.y + b.y) / 2, (a.z + b.z) / 2);
      link.scale.y = len + 0.12;
      link.rotation.x = Math.atan2(dz, dy);
      link.updateMatrixWorld(true);
      objects.push(link);
    }

    const ropes = Math.round((cableZ0 - cableZ1) / 5);

    for (let i = 1; i < ropes; i += 1) {
      const rz = cableZ0 - ((cableZ0 - cableZ1) * i) / ropes;

      if (rz > railMaxZ || rz < railMinZ) {
        continue;
      }

      const cy = cableY(saddles, rz);

      if (cy === null) {
        continue;
      }

      const h = cy - (deckY + 0.9);

      if (h < 0.8) {
        continue;
      }

      const rope = mesh(ropeGeo, ORANGE, ax + sx, deckY + 0.9 + h / 2, rz);
      rope.scale.y = h;
      rope.updateMatrixWorld(true);
      objects.push(rope);
    }
  }
};

const buildSouthAnchorage = ({ ctx, objects, plan }: Build) => {
  const { ax, shoreH, half } = plan;
  const legX = half + LEG_OFF;
  const { z: saddleZ, y: saddleY } = southAnchor(plan);
  const PLATE_H = 1.1;
  const INNER = 2.6;
  const anchorZ = saddleZ - 1.4;

  const tiers = [
    { d: 9.6, top: saddleY - 6.2, w: 4.8 },
    { d: 8.4, top: saddleY - 3, w: 4.4 },
    { d: 7.2, top: saddleY - PLATE_H / 2, w: 4 },
  ] as const;

  for (const sx of [-legX, legX]) {
    const cx = ax + sx;
    const out = Math.sign(sx);
    let footY = shoreH;

    for (const dx of [-2.5, 0, 2.5]) {
      for (const dz of [-4.8, 0, 4.8]) {
        footY = Math.min(footY, ctx.terrain.heightAt(cx + dx, anchorZ + dz));
      }
    }

    let base = footY - 6;

    for (const t of tiers) {
      const off = out * (t.w / 2 - INNER);
      objects.push(
        seatMasonry({
          d: t.d + 0.4,
          h: t.top - base,
          seed: sx + t.d,
          w: t.w + 0.4,
          x: cx + off,
          y: base,
          z: anchorZ,
        }),
      );
      base = t.top;
    }

    objects.push(
      mesh(new THREE.BoxGeometry(3.2, PLATE_H, 4.4), ORANGE, cx - out * 0.6, saddleY, saddleZ),
    );
  }
};

const buildNorthAnchorage = ({ ctx, objects, plan }: Build) => {
  const { ax, half, towerZ } = plan;
  const legX = half + LEG_OFF;
  const { z: nz, y: ny } = northAnchor(plan);
  const saddleSet = cableSaddles(plan);
  let landZ = nz;
  let landY = ny;

  for (let z = towerZ - 4; z >= nz; z -= 1) {
    const cy = cableY(saddleSet, z);

    if (cy === null) {
      continue;
    }

    if (cy <= ctx.terrain.heightAt(ax, z) + 1.2) {
      landZ = z;
      landY = cy;
      break;
    }
  }

  for (const sx of [-legX, legX]) {
    const cx = ax + sx;
    objects.push(
      seatMasonry({
        batter: 0.08,
        d: 8.1,
        h: 9,
        seed: sx * 3 + landZ,
        w: 6.1,
        x: cx,
        y: landY - 0.55 - 9,
        z: landZ,
      }),
      mesh(new THREE.BoxGeometry(3, 1, 4.2), ORANGE, cx, landY, landZ),
    );
  }
};

const buildOverlook = ({ ctx, objects, plan, solids }: Build) => {
  const { ax, landfallZ } = plan;

  if (landfallZ !== null) {
    const ox = ax;
    const oz = -WORLD_HALF_Z + 20;
    const R = 16;
    const SEGS = 14;
    const ARC = (Math.PI * 260) / 180;
    const wallLen = 4.6;

    for (let i = 0; i < SEGS; i += 1) {
      const a = -ARC / 2 + (ARC * (i + 0.5)) / SEGS;
      const px = ox + R * Math.sin(a);
      const pz = oz - R * Math.cos(a);
      const py = ctx.terrain.heightAt(px, pz);
      objects.push(
        seatMasonry({
          courseH: 0.42,
          d: 0.66,
          h: 1.05,
          seed: i * 17 + 3,
          w: wallLen,
          x: px,
          y: py - 0.15,
          yaw: -a,
          z: pz,
        }),
      );
      solids.push({
        maxX: px + wallLen / 2,
        maxZ: pz + 0.33,
        minX: px - wallLen / 2,
        minZ: pz - 0.33,
        yaw: -a,
      });
    }

    const seatProp = (url: string, px: number, pz: number, yaw: number, h: number) => {
      const node = ctx.cache.instance(url);
      node.scale.setScalar(h / Math.max(ctx.cache.bounds(url).size.y, 0.001));
      node.rotation.y = yaw;
      node.position.set(px, ctx.terrain.heightAt(px, pz), pz);
      node.updateMatrixWorld(true);
      objects.push(node);
    };

    for (const deg of [-46, 0, 46]) {
      const a = (deg * Math.PI) / 180;
      const px = ox + (R - 2.4) * Math.sin(a);
      const pz = oz - (R - 2.4) * Math.cos(a);
      seatProp(modelUrl("props", "kk-bench"), px, pz, -a + Math.PI, 0.85);
    }

    for (const s of [-1, 1] as const) {
      const aEnd = (s * ARC) / 2;
      seatProp(
        modelUrl("props", "kk-lamp-old-double"),
        ox + (R - 1.2) * Math.sin(aEnd),
        oz - (R - 1.2) * Math.cos(aEnd),
        -aEnd,
        4.2,
      );
      const aIn = (s * 155 * Math.PI) / 180;
      seatProp(
        modelUrl("props", "planter"),
        ox + (R - 0.5) * Math.sin(aIn),
        oz - (R - 0.5) * Math.cos(aIn),
        0,
        0.8,
      );
    }

    for (let i = 0; i < 12; i += 1) {
      const a = ((-148 + i * 27) * Math.PI) / 180;

      if (Math.abs(a) > (148 * Math.PI) / 180) {
        continue;
      }

      const r = R + 7 + jit(i, 1) * 14;
      const px = ox + r * Math.sin(a) + (jit(i, 2) - 0.5) * 5;
      const pz = Math.max(oz - r * Math.cos(a) + (jit(i, 3) - 0.5) * 5, -WORLD_HALF_Z - 16);

      if (ctx.terrain.heightAt(px, pz) < 3) {
        continue;
      }

      const treeName = PARK_TREES[i % PARK_TREES.length];

      if (!treeName) {
        continue;
      }

      const url = modelUrl("props", treeName);
      seatProp(url, px, pz, jit(i, 4) * Math.PI * 2, 3.8 + jit(i, 5) * 1.7);
      solids.push({
        maxX: px + 0.55,
        maxZ: pz + 0.55,
        minX: px - 0.55,
        minZ: pz - 0.55,
        noBody: true,
      });
    }
  }
};

export const buildGoldenGate = (ctx: GoldenGateCtx) => {
  const objects: THREE.Object3D[] = [];
  const solids: Solid[] = [];
  const plan = goldenGatePlan(ctx);

  if (!plan) {
    return { decks: [], objects, solids };
  }

  const decks = planDecks(ctx, plan);
  const build: Build = { ctx, objects, plan, solids };
  buildDeckBoards(build);
  buildLampPosts(build);
  buildTruss(build);
  buildTowers(build);
  buildCables(build);
  buildSouthAnchorage(build);
  buildNorthAnchorage(build);
  buildOverlook(build);

  return { decks, objects, solids };
};
