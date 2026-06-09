import { MAP_W, MAP_H } from "../config";
import { World, GROUND, inBounds } from "./world";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GenResult = { world: World; spawn: { tx: number; ty: number } };

export function generateFarm(seed = (Math.random() * 1e9) | 0): GenResult {
  const rng = mulberry32(seed);
  const w = new World();

  // base: grass everywhere with varied tiles (weight toward plain variants)
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    w.ground[i] = GROUND.grass;
    const r = rng();
    w.gv[i] = r < 0.55 ? (r < 0.3 ? 1 : 3) : (Math.floor(rng() * 6) as number);
  }

  // pond in the lower-left, organic blob
  const pcx = 9,
    pcy = MAP_H - 9;
  for (let ty = pcy - 4; ty <= pcy + 4; ty++) {
    for (let tx = pcx - 5; tx <= pcx + 5; tx++) {
      if (!inBounds(tx, ty)) continue;
      const dx = (tx - pcx) / 5.2;
      const dy = (ty - pcy) / 3.6;
      if (dx * dx + dy * dy < 1 - rng() * 0.18) {
        w.ground[w.idx(tx, ty)] = GROUND.water;
      }
    }
  }

  // sandy clearing / plaza around the buildings (top area)
  const sandRects = [
    { x: 5, y: 4, w: 18, h: 7 }, // farmyard
  ];
  for (const r of sandRects) {
    for (let ty = r.y; ty < r.y + r.h; ty++)
      for (let tx = r.x; tx < r.x + r.w; tx++) {
        if (inBounds(tx, ty) && w.getGround(tx, ty) === GROUND.grass && rng() < 0.92)
          w.ground[w.idx(tx, ty)] = GROUND.sand;
      }
  }

  const occupied = (tx: number, ty: number) =>
    !inBounds(tx, ty) || w.getGround(tx, ty) === GROUND.water || w.objectAt(tx, ty) !== null;

  // fenced crop field south of the yard — kept clear for planting
  const field = { x0: 7, y0: 16, x1: 18, y1: 23 };
  const inField = (tx: number, ty: number) =>
    tx >= field.x0 && tx <= field.x1 && ty >= field.y0 && ty <= field.y1;
  const inYard = (tx: number, ty: number) => tx >= 4 && tx <= 23 && ty >= 3 && ty <= 13;

  // buildings: house (top-left of yard), shop (top-right of yard), bin near house
  w.addObject({ type: "house", tx: 8, ty: 6, w: 2, h: 3, hp: 1, maxHp: 1 });
  w.addObject({ type: "shop", tx: 19, ty: 6, w: 2, h: 3, hp: 1, maxHp: 1 });
  w.addObject({ type: "bin", tx: 11, ty: 7, w: 1, h: 1, hp: 1, maxHp: 1 });
  w.addObject({ type: "coop", tx: 15, ty: 11, w: 2, h: 3, hp: 1, maxHp: 1 });
  w.addObject({ type: "barn", tx: 21, ty: 11, w: 2, h: 3, hp: 1, maxHp: 1 });

  // a scenic windmill on the open grass to the east
  w.addObject({ type: "windmill", tx: 40, ty: 5, w: 2, h: 2, hp: 1, maxHp: 1 });

  // cave entrance on the rocky east edge
  for (let attempt = 0; attempt < 60; attempt++) {
    const tx = MAP_W - 4 - Math.floor(rng() * 4);
    const ty = 16 + Math.floor(rng() * (MAP_H - 22));
    if (!occupied(tx, ty) && !occupied(tx, ty - 1)) {
      w.addObject({ type: "cave", tx, ty, w: 1, h: 1, hp: 1, maxHp: 1 });
      break;
    }
  }

  // fence the field perimeter, with a gate at top-center facing the yard
  const gateX = Math.floor((field.x0 + field.x1) / 2);
  const fence = (tx: number, ty: number, variant: string) =>
    w.addObject({ type: "fence", tx, ty, w: 1, h: 1, hp: 1, maxHp: 1, variant });
  for (let tx = field.x0; tx <= field.x1; tx++) {
    if (tx !== gateX && tx !== gateX + 1) fence(tx, field.y0, "h");
    fence(tx, field.y1, "h");
  }
  for (let ty = field.y0 + 1; ty < field.y1; ty++) {
    fence(field.x0, ty, "v");
    fence(field.x1, ty, "v");
  }
  // a sand path from the yard down through the gate into the field
  for (let ty = 12; ty <= field.y0; ty++)
    for (let tx = gateX; tx <= gateX + 1; tx++)
      if (inBounds(tx, ty)) w.ground[w.idx(tx, ty)] = GROUND.sand;

  // scatter trees (avoid yard + field + pond), clustered toward edges
  let trees = 0;
  for (let attempt = 0; attempt < 900 && trees < 72; attempt++) {
    const tx = 2 + Math.floor(rng() * (MAP_W - 4));
    const ty = 2 + Math.floor(rng() * (MAP_H - 4));
    if (inYard(tx, ty) || inField(tx, ty)) continue;
    if (occupied(tx, ty) || occupied(tx, ty - 1)) continue;
    const edge = Math.min(tx, ty, MAP_W - 1 - tx, MAP_H - 1 - ty);
    if (rng() > 0.18 + Math.max(0, 8 - edge) * 0.06) continue;
    w.addObject({ type: "tree", tx, ty, w: 1, h: 1, hp: 3, maxHp: 3 });
    trees++;
  }

  // scatter rocks (more toward the right/rocky side)
  let rocks = 0;
  for (let attempt = 0; attempt < 500 && rocks < 34; attempt++) {
    const tx = 2 + Math.floor(rng() * (MAP_W - 4));
    const ty = 2 + Math.floor(rng() * (MAP_H - 4));
    if (inYard(tx, ty) || inField(tx, ty) || occupied(tx, ty)) continue;
    if (rng() > 0.12 + (tx / MAP_W) * 0.22) continue;
    w.addObject({ type: "rock", tx, ty, w: 1, h: 1, hp: 3, maxHp: 3 });
    rocks++;
  }

  // forageable mushrooms on grass (walk-over pick)
  let forage = 0;
  for (let attempt = 0; attempt < 400 && forage < 14; attempt++) {
    const tx = 2 + Math.floor(rng() * (MAP_W - 4));
    const ty = 2 + Math.floor(rng() * (MAP_H - 4));
    if (inYard(tx, ty) || inField(tx, ty) || occupied(tx, ty)) continue;
    if (rng() > 0.25) continue;
    const kind = rng() < 0.65 ? "mushroom_red" : "mushroom_blue";
    w.addObject({
      type: "forage",
      tx,
      ty,
      w: 1,
      h: 1,
      hp: 1,
      maxHp: 1,
      variant: kind,
      solid: false,
    });
    forage++;
  }

  // ---- decorative decals (non-colliding) ----
  const flowers = ["flower_blue", "flower_blue2", "flower_red", "flower_yellow", "flower_white"];
  const grassFree = (tx: number, ty: number) =>
    inBounds(tx, ty) && w.getGround(tx, ty) === GROUND.grass && !w.objectAt(tx, ty);

  let nf = 0;
  for (let attempt = 0; attempt < 900 && nf < 70; attempt++) {
    const tx = 2 + Math.floor(rng() * (MAP_W - 4));
    const ty = 2 + Math.floor(rng() * (MAP_H - 4));
    if (inYard(tx, ty) || !grassFree(tx, ty)) continue;
    w.decals.push({
      type: "flower",
      tx,
      ty,
      variant: flowers[Math.floor(rng() * flowers.length)] ?? "flower_white",
    });
    nf++;
  }
  let nb = 0;
  for (let attempt = 0; attempt < 500 && nb < 22; attempt++) {
    const tx = 2 + Math.floor(rng() * (MAP_W - 4));
    const ty = 2 + Math.floor(rng() * (MAP_H - 4));
    if (inYard(tx, ty) || inField(tx, ty) || !grassFree(tx, ty)) continue;
    w.decals.push({ type: "bush", tx, ty, variant: rng() < 0.5 ? "bush1" : "bush2" });
    nb++;
  }
  // a little boat on the pond
  for (let attempt = 0; attempt < 60; attempt++) {
    const tx = pcx - 2 + Math.floor(rng() * 4);
    const ty = pcy - 1 + Math.floor(rng() * 3);
    if (
      inBounds(tx, ty) &&
      w.getGround(tx, ty) === GROUND.water &&
      w.getGround(tx, ty + 1) === GROUND.water
    ) {
      w.decals.push({ type: "coracle", tx, ty, variant: "" });
      break;
    }
  }

  return { world: w, spawn: { tx: 12, ty: 9 } };
}
