// Render-only set-dressing for a more dynamic dungeon arena. Returns a flat
// list of prop placements the renderer instances onto the terrain. NEVER
// imported under src/sim/* (it has no gameplay effect — purely decorative).
//
// Clip discipline: TALL standing props (full pillars/walls) only sit near the
// real colliders (the r30 pillar ring), behind the spawns, or out by the rim
// wall. The walkable field gets only LOW debris (lying columns, crates,
// barrels, foundation slabs, banners) — same walk-through treatment the
// original crate-beside-pillar dressing already used.
import { CAMPS, HALF, OBSTACLES, SPAWNS } from "./map";

export type Decor = { model: string; x: number; y: number; rot: number; scale: number; lie?: boolean };

export function buildDecor(): Decor[] {
  const out: Decor[] = [];
  const add = (model: string, x: number, y: number, rot: number, scale: number, lie = false): void => {
    out.push({ model, x, y, rot, scale, lie });
  };

  // (the throne platform's stairs + retaining wall are built precisely in
  //  Environment.buildPlatform — they need exact scale/alignment)

  // ── COLONNADE: ruin the outer pillar ring (OBSTACLES[4..9], r30) with a
  //    fallen column + rubble beside each real pillar ──
  const outer = OBSTACLES.slice(4);
  outer.forEach((o, i) => {
    const ang = Math.atan2(o.y, o.x);
    const px = Math.cos(ang + Math.PI / 2);
    const py = Math.sin(ang + Math.PI / 2);
    add("column", o.x + px * 2.8, o.y + py * 2.8, ang + 0.4, 0.9, true); // toppled column
    add(i % 2 === 0 ? "crate_large" : "barrel_large", o.x + px * -1.6, o.y + py * -1.6, i * 1.3, 0.85);
    add("barrel_large", o.x + Math.cos(ang) * 1.7, o.y + Math.sin(ang) * 1.7, i, 0.8);
  });

  // ── CAMPS: a loot stash + broken altar + banner at each skeleton camp (r24) ──
  CAMPS.forEach((c, i) => {
    const ang = Math.atan2(c.y, c.x);
    const ox = Math.cos(ang);
    const oy = Math.sin(ang);
    add("crate_large", c.x + ox * 2.6, c.y + oy * 2.6, i, 0.85);
    add("barrel_large", c.x + ox * 2.6 + oy * 1.0, c.y + oy * 2.6 - ox * 1.0, i * 2, 0.78);
    add("floor_foundation_corner", c.x - ox * 2.4, c.y - oy * 2.4, ang, 0.95); // broken altar
    add(i % 2 === 0 ? "banner_blue" : "banner_red", c.x - oy * 2.4, c.y + ox * 2.4, ang + Math.PI / 2, 0.9);
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
    const a = (i / 12) * Math.PI * 2 + 0.26; // offset off the base spokes
    const r = 44 + (i % 3);
    add(i % 2 === 0 ? "pillar" : "column", Math.cos(a) * r, Math.sin(a) * r, a * 1.7, 0.85, i % 3 !== 0);
  }

  return out.filter((d) => Math.hypot(d.x, d.y) <= HALF - 0.5); // keep inside the wall
}
