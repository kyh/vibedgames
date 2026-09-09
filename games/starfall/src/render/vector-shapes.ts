import type Phaser from "phaser";
import {
  ENEMY_SPECS,
  INVULN_BLINK_MS,
  LANCER_CHARGE_RANGE,
  LEVEL_CAP,
  SHIP_HULL_DEG,
  SHIP_RADIUS,
  UFO_RADIUS,
} from "../shared/constants";
import type { EnemyKind, EnemyState, Vec } from "../shared/constants";
import { DEG } from "../sys/geometry";
import { usesLockedAim } from "./charge-progress";

/** Vector silhouettes and stroke primitives: hull outlines per ship/enemy kind, polygon strokes, telegraph accents and the hull alpha rules. */

/** Saucer outline relative to the UFO's reference point (half-width UFO_RADIUS). */
export const UFO_OUTLINE: readonly { x: number; y: number }[] = [
  { x: -4.5, y: -5 },
  { x: 4.5, y: -5 },
  { x: 7, y: 0 },
  { x: UFO_RADIUS, y: 4.5 },
  { x: 7, y: 9 },
  { x: -7, y: 9 },
  { x: -UFO_RADIUS, y: 4.5 },
  { x: -7, y: 0 },
];

/** GLAIVE: open triangle, side 10 (circumradius 10/√3), 2px stroke. */
export const GLAIVE_TRI: readonly Vec[] = [0, 1, 2].map((i) => {
  const a = (Math.PI * 2 * i) / 3;
  return { x: Math.cos(a) * 5.77, y: Math.sin(a) * 5.77 };
});

export const hexagonPoints = (radius: number): Vec[] => {
  const pts: Vec[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI * 2 * i) / 6;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return pts;
};

/** Hull outline per enemy kind (§6.1 silhouettes), relative to center. */
export const enemyHullPoints = (kind: EnemyKind): readonly Vec[] => {
  switch (kind) {
    case "drone": {
      // Equilateral triangle, side 12 → circumradius ≈ 6.93, nose at +x.
      return [0, 1, 2].map((i) => {
        const a = (Math.PI * 2 * i) / 3;
        return { x: Math.cos(a) * 6.93, y: Math.sin(a) * 6.93 };
      });
    }
    case "wasp": {
      // Chevron, 14 wide, two acute wings, nose at +x.
      return [
        { x: 6, y: 0 },
        { x: -6, y: -7 },
        { x: -2, y: 0 },
        { x: -6, y: 7 },
      ];
    }
    case "lancer": {
      // Narrow dart 20×5 (4:1).
      return [
        { x: 10, y: 0 },
        { x: -10, y: -2.5 },
        { x: -6, y: 0 },
        { x: -10, y: 2.5 },
      ];
    }
    case "splitter": {
      // Pentagon r=12 (pentagram drawn separately).
      return [0, 1, 2, 3, 4].map((i) => {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        return { x: Math.cos(a) * 12, y: Math.sin(a) * 12 };
      });
    }
    case "warden": {
      // Hex bunker, wide, flat-fronted (nose at +x).
      return hexagonPoints(16);
    }
    case "sniper": {
      // Long thin arrowhead, longer than the lancer, nose at +x.
      return [
        { x: 14, y: 0 },
        { x: -8, y: -5 },
        { x: -4, y: 0 },
        { x: -8, y: 5 },
      ];
    }
    case "spawner": {
      // Hexagonal hive.
      return hexagonPoints(14);
    }
    case "dreadnought": {
      // Capital ship: elongated heptagon, nose at +x, ~120 long.
      return [
        { x: 60, y: 0 },
        { x: 36, y: -22 },
        { x: -20, y: -30 },
        { x: -54, y: -16 },
        { x: -54, y: 16 },
        { x: -20, y: 30 },
        { x: 36, y: 22 },
      ];
    }
    default: {
      return kind satisfies never;
    }
  }
};

/** Visual ship scale by level (collision hitbox stays SHIP_RADIUS — leveling
 *  makes you LOOK bigger/tougher, not easier to hit). L1 1.0 → L5 ~1.52. */
export const shipScaleForLevel = (level: number): number => {
  const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
  // L1 1.0 → L3 1.4 (a clear size jump each level)
  return 1 + (L - 1) * 0.2;
};

export const shipHullPoints = (level = 1): { x: number; y: number }[] => {
  const s = shipScaleForLevel(level);
  return SHIP_HULL_DEG.map((deg) => {
    const r = (deg === 180 ? SHIP_RADIUS / 2 : SHIP_RADIUS) * s;
    return { x: Math.cos(deg * DEG) * r, y: Math.sin(deg * DEG) * r };
  });
};

export const strokeClosed = (
  g: Phaser.GameObjects.Graphics,
  pts: readonly { x: number; y: number }[],
): void => {
  const [first] = pts;
  if (!first) {
    return;
  }
  g.beginPath();
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p) {
      g.lineTo(p.x, p.y);
    }
  }
  g.closePath();
  g.strokePath();
};

/** Stroke a closed polygon translated/rotated into world space. */
export const strokeTransformed = (
  g: Phaser.GameObjects.Graphics,
  pts: readonly Vec[],
  x: number,
  y: number,
  rot: number,
): void => {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const [first] = pts;
  if (!first) {
    return;
  }
  g.beginPath();
  g.moveTo(x + first.x * cos - first.y * sin, y + first.x * sin + first.y * cos);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (p) {
      g.lineTo(x + p.x * cos - p.y * sin, y + p.x * sin + p.y * cos);
    }
  }
  g.closePath();
  g.strokePath();
};

export const strokeRegularPolygon = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rot: number,
): void => {
  g.beginPath();
  for (let i = 0; i <= sides; i += 1) {
    const a = rot + (Math.PI * 2 * i) / sides;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) {
      g.moveTo(px, py);
    } else {
      g.lineTo(px, py);
    }
  }
  g.strokePath();
};

export const dashedLine = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  angle: number,
  length: number,
  dash: number,
  gap: number,
): void => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let d = 0; d < length; d += dash + gap) {
    const end = Math.min(d + dash, length);
    g.lineBetween(x + cos * d, y + sin * d, x + cos * end, y + sin * end);
  }
};

/** WARDEN armor ring: closed while shielded; open arcs (visible gaps)
 *  throughout the punish window. */
export const drawWardenArmor = (
  g: Phaser.GameObjects.Graphics,
  e: EnemyState,
  radius: number,
  sw: number,
): void => {
  g.lineStyle(2 * sw, e.shielded ? ENEMY_SPECS.warden.tint : 0xff_ff_ff, e.shielded ? 0.9 : 0.5);
  if (e.shielded) {
    g.strokeCircle(e.x, e.y, radius);
    return;
  }
  for (let i = 0; i < 4; i += 1) {
    const angle = (i * Math.PI) / 2 + 0.2;
    g.beginPath();
    g.arc(e.x, e.y, radius, angle, angle + 1.1);
    g.strokePath();
  }
};

/** Per-kind anticipation cue on top of the shared charge ring: nose glow,
 *  hull brighten (+ charge lane), locked-aim sights, spawner pulse, boss maw. */
export const drawTelegraphAccent = (
  g: Phaser.GameObjects.Graphics,
  e: EnemyState,
  progress: number,
  sw: number,
): void => {
  const spec = ENEMY_SPECS[e.kind];
  if (e.kind === "drone" || e.kind === "warden") {
    const nose = e.kind === "drone" ? 8 : spec.hitRadius;
    g.fillStyle(spec.tint, 0.85);
    g.fillCircle(e.x + Math.cos(e.angle) * nose, e.y + Math.sin(e.angle) * nose, 1 + 3 * progress);
  } else if (e.kind === "wasp" || e.kind === "lancer") {
    g.lineStyle(sw, 0xff_ff_ff, 0.25 + 0.5 * progress);
    strokeTransformed(g, enemyHullPoints(e.kind), e.x, e.y, e.angle);
    if (e.kind === "lancer") {
      g.lineStyle(sw, spec.tint, 0.55 + 0.25 * progress);
      dashedLine(g, e.x, e.y, e.angle, LANCER_CHARGE_RANGE, 8, 6);
    }
  } else if (usesLockedAim(e)) {
    for (const aim of e.lances) {
      g.lineStyle(sw, spec.tint, 0.5 + 0.3 * progress);
      g.lineBetween(e.x, e.y, aim.x, aim.y);
      const targetRadius = (e.kind === "sniper" ? 5 : 7) + 3 * (1 - progress);
      g.strokeCircle(aim.x, aim.y, targetRadius);
      g.lineBetween(aim.x - targetRadius - 3, aim.y, aim.x - targetRadius + 1, aim.y);
      g.lineBetween(aim.x + targetRadius - 1, aim.y, aim.x + targetRadius + 3, aim.y);
      g.lineBetween(aim.x, aim.y - targetRadius - 3, aim.x, aim.y - targetRadius + 1);
      g.lineBetween(aim.x, aim.y + targetRadius - 1, aim.x, aim.y + targetRadius + 3);
    }
  } else if (e.kind === "spawner") {
    g.lineStyle(sw, spec.tint, 0.75);
    g.strokeCircle(e.x, e.y, spec.hitRadius + 4 + 14 * progress);
  } else if (e.kind === "dreadnought") {
    // Each boss phase keeps its own authored charge duration.
    g.fillStyle(spec.tint, 0.45);
    g.fillCircle(e.x + Math.cos(e.angle) * 40, e.y + Math.sin(e.angle) * 40, 4 + 6 * progress);
  }
};

/** ARC bolt: 3 jittered sub-segments per hop, re-rolled every frame. */
export const drawJitteredChain = (
  g: Phaser.GameObjects.Graphics,
  chain: readonly Vec[],
  tint: number,
  now: number,
): void => {
  g.lineStyle(1.6, tint, 0.95);
  for (let i = 0; i < chain.length - 1; i += 1) {
    const a = chain[i];
    const b = chain[i + 1];
    if (!a || !b) {
      continue;
    }
    let px = a.x;
    let py = a.y;
    for (let s = 1; s <= 3; s += 1) {
      const t = s / 3;
      const jitter = s < 3 ? 6 : 0;
      const nx = a.x + (b.x - a.x) * t + Math.sin(now * 0.035 + i * 2.7 + s * 1.9) * jitter;
      const ny = a.y + (b.y - a.y) * t + Math.cos(now * 0.035 + i * 1.9 + s * 2.7) * jitter;
      g.lineBetween(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }
};

export const drawPoly = (
  g: Phaser.GameObjects.Graphics,
  verts: readonly { x: number; y: number }[],
) => {
  g.clear();
  g.lineStyle(1, 0xff_ff_ff, 1);
  strokeClosed(g, verts);
};

export const blinkAlpha = (now: number): number =>
  Math.floor(now / INVULN_BLINK_MS) % 2 === 0 ? 0.9 : 0.3;

/** 4-point open diamond, 1px stroke (mine + booster shells). */
export const strokeDiamond = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  r: number,
): void => {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.strokePath();
};

/** Neon hex ring (the beacon's whole silhouette — a huge static hexagon
 *  reads nothing like a ship). dashFrac < 1 draws each edge as dashes. */
export const strokeHexRing = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  r: number,
  rot: number,
  dashFrac: number,
): void => {
  let px = x + Math.cos(rot) * r;
  let py = y + Math.sin(rot) * r;
  for (let i = 1; i <= 6; i += 1) {
    const a = rot + (i * Math.PI) / 3;
    const nx = x + Math.cos(a) * r;
    const ny = y + Math.sin(a) * r;
    if (dashFrac >= 1) {
      g.lineBetween(px, py, nx, ny);
    } else {
      const dashes = 4;
      for (let d = 0; d < dashes; d += 1) {
        const t0 = d / dashes;
        const t1 = t0 + dashFrac / dashes;
        g.lineBetween(
          px + (nx - px) * t0,
          py + (ny - py) * t0,
          px + (nx - px) * t1,
          py + (ny - py) * t1,
        );
      }
    }
    px = nx;
    py = ny;
  }
};

/** Hull alpha: PHASE ghosts at 0.25, spawn invulnerability blinks, else solid. */
export const shipAlpha = (phased: boolean, invuln: boolean, now: number): number => {
  if (phased) {
    return 0.25;
  }
  return invuln ? blinkAlpha(now) : 1;
};

/** Spawn-grace hull alpha: a steady dim under reduced motion, else a pulse. */
export const graceAlpha = (reduced: boolean, now: number): number =>
  reduced ? 0.6 : 0.4 + 0.2 * Math.sin(now / 80);

export const enemyStrokeWeight = (kind: EnemyKind): number => {
  if (kind === "dreadnought") {
    return 3;
  }
  return kind === "warden" ? 2 : 1;
};
