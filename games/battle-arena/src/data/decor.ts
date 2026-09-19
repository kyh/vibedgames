// Render-only set-dressing for "The Sunken Court" — a hexagonal underground
// dungeon hall (KayKit Dungeon Remastered interior). Returns a flat list of
// prop placements the renderer instances onto the terrain. NEVER imported
// under src/sim/* (it has no gameplay effect — purely decorative).
//
// Zones: Throne Court (center — gold hoard + empty throne), six themed camp
// lairs at the hex vertices (armory / treasury / excavation / cellar /
// woodstore / mimic den), shrine delivery pads on four vertex axes, rune
// shrine columns on the diagonals, supply outposts at the six bases, and
// rubble/debris drifting along the perimeter walls.
//
// Clip discipline: TALL standing props (full pillars/statues) only sit near
// the real colliders (throne pillars / partition runs), behind the spawns, or
// out by the perimeter wall. The walkable field gets only LOW walk-through
// debris.
//
// Determinism: every jittered placement uses hash2 — identical on every
// client, zero runtime RNG.
import {
  APOTHEM,
  CAMPS,
  DELIVERY_PADS,
  EDGE_ANGLES,
  PARTITION_RUNS,
  RUNE_SPOTS,
  SPAWNS,
} from "./map";
import { STAIR_ANGLES } from "../sim/elevation";
import type { MapProp } from "./map-format";

export interface Decor {
  model: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** Topple the prop 90° on Z (fallen debris). */
  lie?: boolean;
  /** Extra Y lift above the terrain (dais-top props, wall-mounted trophies). */
  h?: number;
}

/** Deterministic 2-int hash → [0,1). Identical on every client — decor
 *  placement must never touch runtime RNG. */
export const hash2 = (a: number, b: number): number => {
  // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- int32 wrap for the hash mix
  let n = (a * 374_761_393 + b * 668_265_263) | 0;
  // oxlint-disable-next-line no-bitwise -- xorshift hash mixing
  n = Math.imul(n ^ (n >>> 13), 1_274_126_177);
  // oxlint-disable-next-line no-bitwise -- xorshift mix, then uint32 wrap
  return ((n ^ (n >>> 16)) >>> 0) / 4_294_967_296;
};

/** rotY that points a +Z-forward KayKit model along sim direction (dx, dy).
 *  (Matches the unit renderer: yaw = atan2(aimX, aimY).) */
const faceSim = (dx: number, dy: number): number => Math.atan2(dx, dy);

const TAU = Math.PI * 2;
// dais lift — throne-court props plant on the dais top
const BOSS_TOP = 1.6;

/** Signed distance from the hex boundary (positive = outside). */
const hexDepth = (x: number, y: number): number => {
  let d = -Infinity;
  for (const a of EDGE_ANGLES) {
    const v = x * Math.cos(a) + y * Math.sin(a) - APOTHEM;
    if (v > d) {
      d = v;
    }
  }
  return d;
};

// Custom-map hook (main.ts / map-format.ts): when set, buildDecor() returns
// these placements instead of the procedural default. Render-only — colliders
// travel separately through map.ts's applyMapData.
let decorOverride: Decor[] | null = null;

export const setDecorOverride = (props: MapProp[] | null): void => {
  decorOverride =
    props === null
      ? null
      : props.map((p) => ({
          h: p.h ?? 0,
          lie: p.lie ?? false,
          model: p.model,
          rot: p.rot,
          scale: p.scale,
          x: p.x,
          y: p.y,
        }));
};
const RUBBLE_RING_ANGLES = [0.9, 2.2, -1.7];

const laneClear = (x: number, y: number): boolean => {
  // perpendicular distance to each base→center lane ray (edge angles)
  for (const a of EDGE_ANGLES) {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    // along-lane coordinate
    const t = x * ux + y * uy;
    if (t > 6) {
      const d = Math.abs(-x * uy + y * ux);
      if (d < 4.5) {
        return false;
      }
    }
  }
  return true;
};

type AddDecor = (
  model: string,
  x: number,
  y: number,
  rot: number,
  scale: number,
  lie?: boolean,
  h?: number,
) => void;

const dressCampLairs = (add: AddDecor): void => {
  // ── CAMP LAIRS: each skeleton camp keeps its stash and gains a rubble ring +
  //    a unique theme silhouette (armory / treasury / excavation / cellar /
  //    woodstore / mimic den). All pieces low (≤ ~1.6u) and walk-through,
  //    2.4–3.2u out from center — clear of the 2.2u creep pack ring.
  //    (The 7th "golem" camp gets its frost lair in Environment — its rocks
  //    need a blue-tinted material clone, a renderer concern.) ──
  const lairs = CAMPS.filter((c) => c.id.startsWith("camp"));
  for (const [i, c] of lairs.entries()) {
    // outward (camps sit on the vertex axes)
    const ang = Math.atan2(c.y, c.x);
    const ox = Math.cos(ang);
    const oy = Math.sin(ang);
    const tx = -Math.sin(ang);
    // tangential
    const ty = Math.cos(ang);
    // (the stash crates/barrels/kegs are DESTRUCTIBLE sim props now — see
    //  data/props.ts; only the indestructible dressing stays decor)
    // broken altar
    add("floor_foundation_corner", c.x - ox * 2.4, c.y - oy * 2.4, ang, 0.95);
    add(
      i % 2 === 0 ? "banner_blue" : "banner_red",
      c.x - oy * 2.4,
      c.y + ox * 2.4,
      ang + Math.PI / 2,
      0.9,
    );
    // rubble ring (rubble_half is 3.5u tall natively — scale ~0.4 keeps the
    // chunks ≤ ~1.5u so camps stay camera/sightline-safe)
    for (const [k, da] of RUBBLE_RING_ANGLES.entries()) {
      const rx = Math.cos(ang + da);
      const ry = Math.sin(ang + da);
      add(
        "rubble_half",
        c.x + rx * 3,
        c.y + ry * 3,
        hash2(i * 7 + k, 13) * TAU,
        0.36 + hash2(i * 3 + k, 5) * 0.08,
      );
    }
    // theme centerpiece(s)
    if (i === 0) {
      // Armory: a battle trophy raised on a post
      const px = c.x - ox * 2.8;
      const py = c.y - oy * 2.8;
      // 4u post scaled to ~2.2
      add("post", px, py, ang, 0.55);
      // mounted at the post top
      add("sword_shield_broken", px, py, faceSim(ox, oy), 0.8, false, 1.4);
      add("rocks_small", c.x - tx * 1.5, c.y - ty * 1.5, hash2(i, 17) * TAU, 1.1);
    } else if (i === 1) {
      // Treasury (the golem vertex — gold spills toward the lair)
      add("rocks_gold", c.x + tx * 2.4, c.y + ty * 2.4, 0.7, 1.1);
      add("chest", c.x - ox * 2.6, c.y - oy * 2.6, faceSim(ox, oy), 0.9);
      add(
        "coin_stack_small",
        c.x + ox * 2.5 + tx * 1.2,
        c.y + oy * 2.5 + ty * 1.2,
        hash2(1, 19) * TAU,
        0.9,
      );
      add(
        "coin_stack_small",
        c.x + ox * 2.5 - tx * 1.2,
        c.y + oy * 2.5 - ty * 1.2,
        hash2(2, 19) * TAU,
        0.9,
      );
    } else if (i === 2) {
      // Excavation
      add("scaffold_frame_small", c.x + ox * 3, c.y + oy * 3, ang + 0.4, 1);
      add("bucket_pickaxes", c.x + tx * 2.2, c.y + ty * 2.2, hash2(i, 23) * TAU, 0.95);
      add("rocks_small", c.x - tx * 2, c.y - ty * 2, hash2(i, 29) * TAU, 1);
    } else if (i === 3) {
      // Cellar (its keg hoard is destructible — data/props.ts)
    } else if (i === 4) {
      // Woodstore: felled trunks (its keg is destructible — data/props.ts)
      add("trunk_large_A", c.x + tx * 2.9, c.y + ty * 2.9, ang + 0.5, 1, true);
      add("trunk_large_A", c.x - ox * 2.7, c.y - oy * 2.7, ang - 0.9, 0.85, true);
      add("rocks", c.x - tx * 2.2, c.y - ty * 2.2, hash2(7, 37) * TAU, 0.8);
    } else if (i === 5) {
      // Mimic den — the open-mouth silhouette faces approaching players
      add("chest_mimic", c.x + ox * 2.7, c.y + oy * 2.7, faceSim(-ox, -oy), 1);
      add("chest", c.x - tx * 1.8, c.y - ty * 1.8, 1.9, 0.85);
      add("candle_triple", c.x + ox * 2 + tx * 1.4, c.y + oy * 2 + ty * 1.4, 0, 1);
      add("candle_triple", c.x + ox * 2 - tx * 1.4, c.y + oy * 2 - ty * 1.4, 0, 1);
    }
  }

  // (base-outpost supply crates are destructible sim props now — data/props.ts)
};

const dressPartitions = (add: AddDecor): void => {
  // ── PARTITION DRESSING: rubble at one end of each cover run (the barrel/
  //    crate that closed the other end is a destructible prop now) ──
  for (const [i, run] of PARTITION_RUNS.entries()) {
    const tx = Math.cos(run.dir);
    const ty = Math.sin(run.dir);
    const end = (run.offsets.at(-1) ?? 3) + 2.2;
    const side = i % 2 === 0 ? 1 : -1;
    add("rubble_half", run.x - tx * end * side, run.y - ty * end * side, hash2(i, 82) * TAU, 0.34);
  }
};

const dressPerimeter = (add: AddDecor): void => {
  // ── PERIMETER DEBRIS: toppled pillars/columns + rubble half-sunk along the
  //    walls, in the gaps between bases, camps, and the golem lair. Count
  //    scales with the wall length (the hall doubled — 12 pieces read empty). ──
  // ≈ 20 at the 62-hall
  const perimN = Math.round(APOTHEM / 2.7);
  for (let i = 0; i < perimN; i += 1) {
    const a = (i / perimN) * TAU + 0.22;
    const r = APOTHEM - 2.4 - (i % 3) * 1.3;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    // keep clear of every base gate (edge midpoints) and the camp vertices
    let clear = true;
    for (const s of SPAWNS) {
      if ((x - s.x) ** 2 + (y - s.y) ** 2 < 9 * 9) {
        clear = false;
      }
    }
    for (const c of CAMPS) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 < 8 * 8) {
        clear = false;
      }
    }
    if (!clear) {
      continue;
    }
    add(i % 2 === 0 ? "pillar" : "column", x, y, a * 1.7, 0.85, i % 3 !== 0);
    if (i % 4 === 1) {
      add(
        "rubble_half",
        x + Math.cos(a + 1.3) * 2,
        y + Math.sin(a + 1.3) * 2,
        hash2(i, 87) * TAU,
        0.35,
      );
    }
    if (i % 4 === 3) {
      add(
        "rocks",
        x + Math.cos(a - 1.1) * 2.3,
        y + Math.sin(a - 1.1) * 2.3,
        hash2(i, 88) * TAU,
        0.85,
      );
    }
  }
};

const dressMidBand = (add: AddDecor): void => {
  // ── MID-BAND SCATTER: the resize opened a wide ring between the partition
  //    cover (r≈31) and the wall features (r≈45+). Fill it with LOW walk-
  //    through debris vignettes — texture, not cover. All hash-placed with
  //    keep-clear rules: base lanes, camps, pads, rune shrines, partitions. ──
  // ≈ 27 attempts
  const scatterN = Math.round(APOTHEM * 0.5);
  for (let i = 0; i < scatterN; i += 1) {
    const a = hash2(i, 301) * TAU;
    // ≈ 29..47
    const r = APOTHEM * (0.55 + hash2(i, 302) * 0.32);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    let clear = laneClear(x, y);
    for (const s of SPAWNS) {
      if ((x - s.x) ** 2 + (y - s.y) ** 2 < 9 * 9) {
        clear = false;
      }
    }
    for (const c of CAMPS) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 < 8 * 8) {
        clear = false;
      }
    }
    for (const p of DELIVERY_PADS) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 < 7 * 7) {
        clear = false;
      }
    }
    for (const p of RUNE_SPOTS) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 < 7 * 7) {
        clear = false;
      }
    }
    for (const run of PARTITION_RUNS) {
      if ((x - run.x) ** 2 + (y - run.y) ** 2 < 6.5 * 6.5) {
        clear = false;
      }
    }
    if (!clear) {
      continue;
    }
    const pick = hash2(i, 303);
    if (pick < 0.4) {
      add("rocks_small", x, y, hash2(i, 304) * TAU, 0.9 + hash2(i, 305) * 0.4);
    } else if (pick < 0.65) {
      add("rubble_half", x, y, hash2(i, 304) * TAU, 0.3 + hash2(i, 305) * 0.1);
    } else if (pick < 0.85) {
      add("rocks", x, y, hash2(i, 304) * TAU, 0.7 + hash2(i, 305) * 0.3);
    } else {
      // rare vignette: a sunken foundation slab with a candle
      add("floor_foundation_corner", x, y, hash2(i, 306) * TAU, 0.8);
      add("candle_triple", x + 1.3, y + 0.6, hash2(i, 307) * TAU, 1);
    }
  }
};

const dressWallBanners = (add: AddDecor): void => {
  // ── WALL BANNERS: cloth between the gates — the taller hall walls read
  //    bare at 62. Two per edge segment, alternating war colors. ──
  for (const [k, a] of EDGE_ANGLES.entries()) {
    for (const off of [-0.13, 0.13]) {
      const ba = a + off;
      const wr = APOTHEM - 0.5;
      add(
        k % 2 === 0 ? "banner_red" : "banner_blue",
        Math.cos(ba) * wr,
        Math.sin(ba) * wr,
        Math.PI / 2 - ba,
        1.15,
        false,
        2.6,
      );
    }
  }
};

const dressThroneCourt = (add: AddDecor): void => {
  // ── THRONE COURT: the weenie. An empty throne over a gold hoard on the dais
  //    top (h = BOSS_TOP plants everything at dais height, y ≈ 3.6) ──
  // faces the arena center (+Z convention — if the model reads backwards at
  // runtime, flip by adding π here)
  add("vampire_throne", 0, -3.3, faceSim(0, 3.3), 1, false, BOSS_TOP);
  add("chest_gold", 2.9, 1.4, -2.2, 1, false, BOSS_TOP);
  add("chest_large_gold", -2.6, -1.9, 0.9, 1, false, BOSS_TOP);
  add("chest", -3.3, 1.8, 2.6, 0.9, false, BOSS_TOP);
  // coin hoard: golden-angle scatter, sightline gap kept clear toward −π/2 so
  // the throne reads from the south approach
  for (let i = 0; i < 17; i += 1) {
    const angle = 0.6 + i * 2.39996;
    const gap = Math.atan2(Math.sin(angle + Math.PI / 2), Math.cos(angle + Math.PI / 2));
    if (Math.abs(gap) < 0.5) {
      continue;
    }
    const r = 2 + hash2(i, 7) * 2.6;
    const model = i % 3 === 2 ? "coin_stack_medium" : "coin_stack_small";
    add(
      model,
      Math.cos(angle) * r,
      Math.sin(angle) * r,
      hash2(i, 11) * TAU,
      0.8 + hash2(i, 3) * 0.4,
      false,
      BOSS_TOP,
    );
  }
  // plateau banner ring: gold cloth flanking each grand stair
  for (const a of STAIR_ANGLES) {
    for (const off of [-0.3, 0.3]) {
      const ba = a + off;
      add(
        "banner_thin_yellow",
        Math.cos(ba) * 9.9,
        Math.sin(ba) * 9.9,
        faceSim(-Math.cos(ba), -Math.sin(ba)),
        1,
      );
    }
  }
  // grand-stair flanking candles at the ramp feet
  for (const a of STAIR_ANGLES) {
    for (const off of [-0.26, 0.26]) {
      const ca = a + off;
      add(
        "candle_triple",
        Math.cos(ca) * 12.6,
        Math.sin(ca) * 12.6,
        hash2(Math.round(a * 100), Math.round(off * 100)) * TAU,
        1,
      );
    }
  }
};

const dressShrinePads = (add: AddDecor): void => {
  // ── SHRINE PADS: statue (rendered via the OBSTACLES model field) + posts +
  //    candles + white banner on the outward side of each delivery pad ──
  for (const p of DELIVERY_PADS) {
    const a = Math.atan2(p.y, p.x);
    const pr = Math.hypot(p.x, p.y);
    for (const off of [-0.14, 0.14]) {
      const pa = a + off;
      // 4u post scaled to ~2.8
      add("post", Math.cos(pa) * (pr + 2.2), Math.sin(pa) * (pr + 2.2), a, 0.7);
    }
    for (const off of [-0.13, 0.13]) {
      const ca = a + off;
      add("candle_triple", Math.cos(ca) * (pr + 1.6), Math.sin(ca) * (pr + 1.6), a, 1);
    }
    add(
      "banner_white",
      Math.cos(a) * (pr + 5.4),
      Math.sin(a) * (pr + 5.4),
      faceSim(-Math.cos(a), -Math.sin(a)),
      0.95,
    );
  }
};

const dressRuneShrines = (add: AddDecor): void => {
  // ── RUNE SHRINES (diagonals, render-only — pre-seeding Phase 2): a
  //    decorated column overlooking each reserved rune spot, candles + rocks
  //    at its base. pillar_decorated is in the renderer's tall set (target
  //    3.8·scale), so scale 3.4/3.8 yields the spec'd 3.4u shrine column. ──
  for (const [i, p] of RUNE_SPOTS.entries()) {
    const a = Math.atan2(p.y, p.x);
    const ox = Math.cos(a);
    const oy = Math.sin(a);
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const mr = Math.hypot(p.x, p.y) + 2.6;
    const mx = ox * mr;
    const my = oy * mr;
    add("pillar_decorated", mx, my, faceSim(-ox, -oy), 3.4 / 3.8);
    add("rocks_small", mx + tx * 1.2 - ox * 0.4, my + ty * 1.2 - oy * 0.4, hash2(i, 61) * TAU, 1.2);
    add("candle_triple", mx - tx * 1.3 + ox * 0.3, my - ty * 1.3 + oy * 0.3, hash2(i, 62) * TAU, 1);
  }
};

/** The procedural default dressing (also the editor's RESET baseline). */
export const buildProceduralDecor = (): Decor[] => {
  const out: Decor[] = [];
  const add: AddDecor = (model, x, y, rot, scale, lie = false, h = 0) => {
    out.push({ h, lie, model, rot, scale, x, y });
  };

  // (the throne platform's stairs + retaining wall are built precisely in
  //  Environment.buildPlatform — they need exact scale/alignment; likewise the
  //  perimeter walls, second story, and partition runs)

  dressCampLairs(add);
  dressPartitions(add);
  dressPerimeter(add);
  dressMidBand(add);
  dressWallBanners(add);
  dressThroneCourt(add);
  dressShrinePads(add);
  dressRuneShrines(add);

  // interior decor stays inside the perimeter wall
  const inside = out.filter((d) => hexDepth(d.x, d.y) <= -0.5);

  // ── ON THE WALL (exempt from the interior clamp) ──
  // gate trophies: a broken sword-and-shield mounted over each base gate
  // (rot matches the wall-segment tangent; h lifts it onto the wall face)
  for (const sp of SPAWNS) {
    const a = Math.atan2(sp.y, sp.x);
    // proud of the gate's inner wall face
    const gr = APOTHEM + 0.75;
    inside.push({
      h: 2.5,
      model: "sword_shield_broken",
      rot: Math.PI / 2 - a,
      scale: 1,
      x: Math.cos(a) * gr,
      y: Math.sin(a) * gr,
    });
  }

  return inside;
};

/** The renderer's set-dressing list: the custom-map override when one is
 *  loaded, else the procedural default. */
export const buildDecor = (): Decor[] => decorOverride ?? buildProceduralDecor();
