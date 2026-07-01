// Render-only set-dressing for "The Sunken Court" — a ruined underground
// throne-court arena. Returns a flat list of prop placements the renderer
// instances onto the terrain. NEVER imported under src/sim/* (it has no
// gameplay effect — purely decorative).
//
// Zones (compass): Throne Court (center, gold hoard), Gold Road (east, camp1
// treasury), The Breach (west 160°–200°, forest invading through the collapsed
// wall), themed camp lairs, shrine delivery pads, rim gates per base, rune
// monoliths on the cardinals.
//
// Clip discipline: TALL standing props (full pillars/walls/trees) only sit near
// the real colliders (pillar rings / Breach tree obstacles), behind the spawns,
// or out by the rim wall. The walkable field gets only LOW walk-through debris.
//
// Determinism: every jittered placement uses hash2 — identical on every client,
// zero runtime RNG.
import { CAMPS, DELIVERY_PADS, HALF, OBSTACLES, RUNE_SPOTS, SPAWNS } from "./map";
import { STAIR_ANGLES } from "../sim/elevation";

export type Decor = {
  model: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** Topple the prop 90° on Z (fallen debris). */
  lie?: boolean;
  /** Extra Y lift above the terrain (dais-top props, wall-mounted trophies). */
  h?: number;
};

/** Deterministic 2-int hash → [0,1). Identical on every client — decor
 *  placement must never touch runtime RNG. */
export function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** rotY that points a +Z-forward KayKit model along sim direction (dx, dy).
 *  (Matches the unit renderer: yaw = atan2(aimX, aimY).) */
function faceSim(dx: number, dy: number): number {
  return Math.atan2(dx, dy);
}

const TAU = Math.PI * 2;
const BOSS_TOP = 1.6; // dais lift — throne-court props plant on the dais top

export function buildDecor(): Decor[] {
  const out: Decor[] = [];
  const add = (model: string, x: number, y: number, rot: number, scale: number, lie = false, h = 0): void => {
    out.push({ model, x, y, rot, scale, lie, h });
  };

  // (the throne platform's stairs + retaining wall are built precisely in
  //  Environment.buildPlatform — they need exact scale/alignment)

  // ── COLONNADE: ruin the outer pillar ring (OBSTACLES[4..9], r30) with a
  //    fallen column + rubble beside each real pillar ──
  const outer = OBSTACLES.slice(4, 10); // exactly the r30 pillars (statues/trees follow)
  outer.forEach((o, i) => {
    const ang = Math.atan2(o.y, o.x);
    const px = Math.cos(ang + Math.PI / 2);
    const py = Math.sin(ang + Math.PI / 2);
    add("column", o.x + px * 2.8, o.y + py * 2.8, ang + 0.4, 0.9, true); // toppled column
    add(i % 2 === 0 ? "crate_large" : "barrel_large", o.x + px * -1.6, o.y + py * -1.6, i * 1.3, 0.85);
    add("barrel_large", o.x + Math.cos(ang) * 1.7, o.y + Math.sin(ang) * 1.7, i, 0.8);
  });

  // ── CAMP LAIRS: each skeleton camp keeps its stash and gains a rubble ring +
  //    a unique theme silhouette (armory / treasury / excavation / cellar /
  //    overgrown / mimic den). All pieces low (≤ ~1.6u) and walk-through,
  //    2.4–3.2u out from center — clear of the 2.2u creep pack ring.
  //    (The 7th "golem" camp gets its frost lair in Environment — its rocks
  //    need a blue-tinted material clone, a renderer concern.) ──
  const lairs = CAMPS.filter((c) => c.id.startsWith("camp"));
  lairs.forEach((c, i) => {
    const ang = Math.atan2(c.y, c.x);
    const ox = Math.cos(ang);
    const oy = Math.sin(ang);
    const tx = -Math.sin(ang);
    const ty = Math.cos(ang); // tangential
    // existing stash: crates + broken altar + banner
    add("crate_large", c.x + ox * 2.6, c.y + oy * 2.6, i, 0.85);
    add("barrel_large", c.x + ox * 2.6 + oy * 1.0, c.y + oy * 2.6 - ox * 1.0, i * 2, 0.78);
    add("floor_foundation_corner", c.x - ox * 2.4, c.y - oy * 2.4, ang, 0.95); // broken altar
    add(i % 2 === 0 ? "banner_blue" : "banner_red", c.x - oy * 2.4, c.y + ox * 2.4, ang + Math.PI / 2, 0.9);
    // rubble ring (rubble_half is 3.5u tall natively — scale ~0.4 keeps the
    // chunks ≤ ~1.5u so camps stay camera/sightline-safe)
    for (let k = 0; k < 3; k++) {
      const da = k === 0 ? 0.9 : k === 1 ? 2.2 : -1.7;
      const rx = Math.cos(ang + da);
      const ry = Math.sin(ang + da);
      add("rubble_half", c.x + rx * 3.0, c.y + ry * 3.0, hash2(i * 7 + k, 13) * TAU, 0.36 + hash2(i * 3 + k, 5) * 0.08);
    }
    // theme centerpiece(s)
    if (i === 0) {
      // Armory: a battle trophy raised on a post
      const px = c.x - ox * 2.8;
      const py = c.y - oy * 2.8;
      add("post", px, py, ang, 0.55); // 4u post scaled to ~2.2
      add("sword_shield_broken", px, py, faceSim(ox, oy), 0.8, false, 1.4); // mounted at the post top
      add("rock_b", c.x - tx * 1.5, c.y - ty * 1.5, hash2(i, 17) * TAU, 0.9);
    } else if (i === 1) {
      // Treasury (Gold Road)
      add("rocks_gold", c.x + tx * 2.4, c.y + ty * 2.4, 0.7, 1.1);
      add("chest", c.x - ox * 2.6, c.y - oy * 2.6, faceSim(ox, oy), 0.9);
      add("coin_stack_small", c.x + ox * 2.5 + tx * 1.2, c.y + oy * 2.5 + ty * 1.2, hash2(1, 19) * TAU, 0.9);
      add("coin_stack_small", c.x + ox * 2.5 - tx * 1.2, c.y + oy * 2.5 - ty * 1.2, hash2(2, 19) * TAU, 0.9);
    } else if (i === 2) {
      // Excavation
      add("scaffold_frame_small", c.x + ox * 3.0, c.y + oy * 3.0, ang + 0.4, 1.0);
      add("bucket_pickaxes", c.x + tx * 2.2, c.y + ty * 2.2, hash2(i, 23) * TAU, 0.95);
      add("rocks_small", c.x - tx * 2.0, c.y - ty * 2.0, hash2(i, 29) * TAU, 1.0);
    } else if (i === 3) {
      // Cellar
      add("keg", c.x + ox * 2.6 + tx * 0.8, c.y + oy * 2.6 + ty * 0.8, hash2(3, 31) * TAU, 0.9);
      add("keg", c.x + ox * 2.6 - tx * 0.6, c.y + oy * 2.6 - ty * 0.6, hash2(4, 31) * TAU, 0.9);
      add("crates_stacked", c.x - tx * 2.8, c.y - ty * 2.8, ang + 1.1, 0.85);
    } else if (i === 4) {
      // Overgrown lair (in the Breach)
      add("trunk_large_A", c.x + tx * 2.9, c.y + ty * 2.9, ang + 0.5, 1.0, true);
      add("bush_a", c.x + ox * 1.7 + tx * 2.6, c.y + oy * 1.7 + ty * 2.6, hash2(5, 37) * TAU, 1.1);
      add("bush_a", c.x + ox * 1.7 - tx * 2.6, c.y + oy * 1.7 - ty * 2.6, hash2(6, 37) * TAU, 1.1);
      add("rock_a", c.x - ox * 2.4, c.y - oy * 2.4, hash2(7, 37) * TAU, 1.0);
    } else if (i === 5) {
      // Mimic den — the open-mouth silhouette faces approaching players
      add("chest_mimic", c.x + ox * 2.7, c.y + oy * 2.7, faceSim(-ox, -oy), 1.0);
      add("chest", c.x - tx * 1.8, c.y - ty * 1.8, 1.9, 0.85);
      add("candle_triple", c.x + ox * 2.0 + tx * 1.4, c.y + oy * 2.0 + ty * 1.4, 0, 1.0);
      add("candle_triple", c.x + ox * 2.0 - tx * 1.4, c.y + oy * 2.0 - ty * 1.4, 0, 1.0);
    }
  });

  // ── BASE OUTPOSTS: just low supply crates flanking each spawn (the base
  //    already has a torch + team banner; the spawn→wall gap is too tight for
  //    a fort, and tall pieces would crowd the chase camera) ──
  SPAWNS.forEach((s, i) => {
    const ang = Math.atan2(s.y, s.x); // outward
    const rx = -Math.sin(ang);
    const ry = Math.cos(ang); // tangential
    add("crate_large", s.x + rx * 3.4, s.y + ry * 3.4, i, 0.8);
    add("barrel_large", s.x - rx * 3.4, s.y - ry * 3.4, i * 2, 0.78);
  });

  // ── RIM WILD: scattered toppled pillars/columns half-sunk in the berm, in
  //    the gaps between the bases (r44-46, hugging the wall) ──
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + 0.26; // offset off the base spokes
    const r = 44 + (i % 3);
    add(i % 2 === 0 ? "pillar" : "column", Math.cos(a) * r, Math.sin(a) * r, a * 1.7, 0.85, i % 3 !== 0);
  }

  // ── THRONE COURT: the weenie. An empty throne over a gold hoard on the dais
  //    top (h = BOSS_TOP plants everything at dais height, y ≈ 3.6) ──
  // faces the arena center (+Z convention — if the model reads backwards at
  // runtime, flip by adding π here)
  add("vampire_throne", 0, -3.3, faceSim(0, 3.3), 1.0, false, BOSS_TOP);
  add("chest_gold", 2.9, 1.4, -2.2, 1.0, false, BOSS_TOP);
  add("chest_large_gold", -2.6, -1.9, 0.9, 1.0, false, BOSS_TOP);
  add("chest", -3.3, 1.8, 2.6, 0.9, false, BOSS_TOP);
  // coin hoard: golden-angle scatter, sightline gap kept clear toward −π/2 so
  // the throne reads from the south approach
  for (let i = 0; i < 17; i++) {
    const angle = 0.6 + i * 2.39996;
    const gap = Math.atan2(Math.sin(angle + Math.PI / 2), Math.cos(angle + Math.PI / 2));
    if (Math.abs(gap) < 0.5) continue;
    const r = 2.0 + hash2(i, 7) * 2.6;
    const model = i % 3 === 2 ? "coin_stack_medium" : "coin_stack_small";
    add(model, Math.cos(angle) * r, Math.sin(angle) * r, hash2(i, 11) * TAU, 0.8 + hash2(i, 3) * 0.4, false, BOSS_TOP);
  }
  // plateau banner ring: gold cloth flanking each grand stair
  for (const a of STAIR_ANGLES) {
    for (const off of [-0.3, 0.3]) {
      const ba = a + off;
      add("banner_thin_yellow", Math.cos(ba) * 9.9, Math.sin(ba) * 9.9, faceSim(-Math.cos(ba), -Math.sin(ba)), 1.0);
    }
  }
  // grand-stair flanking candles at the ramp feet
  for (const a of STAIR_ANGLES) {
    for (const off of [-0.26, 0.26]) {
      const ca = a + off;
      add("candle_triple", Math.cos(ca) * 12.6, Math.sin(ca) * 12.6, hash2(Math.round(a * 100), Math.round(off * 100)) * TAU, 1.0);
    }
  }

  // ── SHRINE PADS: statue (rendered via the OBSTACLES model field) + posts +
  //    candles + white banner on the outward side of each delivery pad ──
  for (const p of DELIVERY_PADS) {
    const a = Math.atan2(p.y, p.x);
    for (const off of [-0.115, 0.115]) {
      const pa = a + off;
      add("post", Math.cos(pa) * 25.6, Math.sin(pa) * 25.6, a, 0.7); // 4u post scaled to ~2.8
    }
    for (const off of [-0.1, 0.1]) {
      const ca = a + off;
      add("candle_triple", Math.cos(ca) * 25.2, Math.sin(ca) * 25.2, a, 1.0);
    }
    add("banner_white", Math.cos(a) * 28.2, Math.sin(a) * 28.2, faceSim(-Math.cos(a), -Math.sin(a)), 0.95);
  }

  // ── THE BREACH (west, 160°–200°, r > 26): the forest invades through the
  //    collapsed wall. Canopy trees keep ≥2.5u off the exact 180° axis between
  //    r24–40 (rune approach / throne glimpse) and sit r ≥ 30 ──
  const canopy: [string, number, number, number, number][] = [
    ["tree_a", -35.9, 12.1, 0.7, 1.15],
    ["tree_c", -40.6, 8.9, 2.1, 1.3],
    ["tree_b", -44.1, 3.5, 4.0, 1.0],
    ["tree_a", -43.0, -5.0, 1.3, 1.25],
    ["tree_c", -39.8, -11.3, 5.2, 1.1],
    ["tree_b", -34.7, -8.3, 2.9, 0.9],
    ["tree_bare", -31.2, 10.4, 0.4, 1.0],
    ["tree_bare", -30.5, -11.5, 3.6, 0.95],
  ];
  for (const [model, x, y, rot, scale] of canopy) add(model, x, y, rot, scale);
  // hash-scattered undergrowth (deterministic — same on every client)
  for (let k = 0; k < 10; k++) {
    const a = Math.PI + (hash2(k, 31) - 0.5) * 0.66;
    const r = 29 + hash2(k, 32) * 15;
    add(k % 2 === 0 ? "bush_a" : "bush_b", Math.cos(a) * r, Math.sin(a) * r, hash2(k, 33) * TAU, 0.9 + hash2(k, 34) * 0.4);
  }
  for (let k = 0; k < 8; k++) {
    const a = Math.PI + (hash2(k, 41) - 0.5) * 0.66;
    const r = 29 + hash2(k, 42) * 15;
    add(k % 2 === 0 ? "rock_a" : "rock_b", Math.cos(a) * r, Math.sin(a) * r, hash2(k, 43) * TAU, 0.9 + hash2(k, 44) * 0.4);
  }
  for (let k = 0; k < 16; k++) {
    const a = Math.PI + (hash2(k, 51) - 0.5) * 0.7;
    const r = 27 + hash2(k, 52) * 18;
    add("grass_a", Math.cos(a) * r, Math.sin(a) * r, hash2(k, 53) * TAU, 1.0 + hash2(k, 54) * 0.5);
  }
  // the ruin losing to the forest: weed-cracked tiles at the sector's inner edge
  for (let k = 0; k < 5; k++) {
    const a = Math.PI + (hash2(k, 55) - 0.5) * 0.62;
    const r = 26 + hash2(k, 56) * 3;
    add("floor_tile_small_weeds_A", Math.cos(a) * r, Math.sin(a) * r, Math.floor(hash2(k, 57) * 4) * (Math.PI / 2), 1.0);
  }
  add("trunk_large_A", -28.5, 5.5, 0.8, 1.0, true); // fallen trunk at the treeline

  // ── RUNE MONOLITHS (cardinals, render-only — pre-seeding Phase 2): a
  //    decorated pillar overlooking each reserved rune spot, rocks at its base.
  //    pillar_decorated is in the renderer's tall set (target 3.8·scale), so
  //    scale 3.4/3.8 yields the spec'd 3.4u monolith. ──
  RUNE_SPOTS.forEach((p, i) => {
    const a = Math.atan2(p.y, p.x);
    const ox = Math.cos(a);
    const oy = Math.sin(a);
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const mx = ox * 35.5;
    const my = oy * 35.5;
    add("pillar_decorated", mx, my, faceSim(-ox, -oy), 3.4 / 3.8);
    add("rock_b", mx + tx * 1.2 - ox * 0.4, my + ty * 1.2 - oy * 0.4, hash2(i, 61) * TAU, 1.35);
    add("rock_b", mx - tx * 1.3 + ox * 0.3, my - ty * 1.3 + oy * 0.3, hash2(i, 62) * TAU, 1.3);
    if (i === 2) {
      // west monolith is overgrown (it stands in the Breach)
      add("bush_b", mx + tx * 1.5 + ox * 0.9, my + ty * 1.5 + oy * 0.9, hash2(i, 63) * TAU, 1.15);
      add("bush_b", mx - tx * 1.4 - ox * 0.8, my - ty * 1.4 - oy * 0.8, hash2(i, 64) * TAU, 1.15);
    }
  });

  // interior decor stays inside the rim wall
  const inside = out.filter((d) => Math.hypot(d.x, d.y) <= HALF - 0.5);

  // ── BEYOND THE WALL (exempt from the interior clamp) ──
  // Breach vista canopy: moonlit silhouettes showing through the wall holes
  // (joins the same instanced tree groups — zero extra draw calls)
  const vista: [string, number][] = [
    ["tree_c", 161],
    ["tree_a", 167.5],
    ["tree_c", 174],
    ["tree_b", 181],
    ["tree_a", 187.5],
    ["tree_c", 194],
    ["tree_b", 200.5],
  ];
  vista.forEach(([model, deg], k) => {
    const a = (deg * Math.PI) / 180;
    const r = 52 + hash2(k, 71) * 6;
    inside.push({ model, x: Math.cos(a) * r, y: Math.sin(a) * r, rot: hash2(k, 73) * TAU, scale: 1.4 + hash2(k, 72) * 0.3 });
  });
  // gate trophies: a broken sword-and-shield mounted over each base gate
  // (rot matches the wall-segment tangent; h lifts it onto the wall face)
  for (const sp of SPAWNS) {
    const a = Math.atan2(sp.y, sp.x);
    inside.push({ model: "sword_shield_broken", x: Math.cos(a) * 49.2, y: Math.sin(a) * 49.2, rot: Math.PI / 2 - a, scale: 1.0, h: 1.35 });
  }

  return inside;
}
