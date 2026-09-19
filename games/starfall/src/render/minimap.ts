import type Phaser from "phaser";
import { BEACON_TINT, ENEMY_SHOT_TINT } from "../shared/constants";
import type { ItemState, SharedState } from "../shared/constants";
import { inWorld } from "../sys/geometry";
import { itemTint } from "./tint";

/** Minimap glyphs for the host-owned world (rocks, enemies, UFO, beacon, items) inside a scaled frame. */

/** Minimap box origin + the live play-area → box scale. */
export interface MinimapFrame {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
}

/** Host-owned world on the minimap: rocks, enemies (boss = hollow square),
 *  the blinking UFO marker and the pulsing BEACON diamond. Graphics has no
 *  auto-clip, so everything is bounds-checked against the play area. */
export const drawMinimapWorld = (
  g: Phaser.GameObjects.Graphics,
  w: SharedState,
  m: MinimapFrame,
  now: number,
): void => {
  for (const a of w.asteroids) {
    if (!inWorld(a.x, a.y, 0, m.pw, m.ph)) {
      continue;
    }
    g.fillStyle(0xff_ff_ff, 0.3);
    g.fillCircle(m.x0 + a.x * m.sx, m.y0 + a.y * m.sy, Math.max(1, a.radius * m.sx * 0.3));
  }
  for (const e of w.enemies) {
    if (!inWorld(e.x, e.y, 0, m.pw, m.ph)) {
      continue;
    }
    if (e.kind === "dreadnought") {
      // qa-010: the boss is not fodder — a hollow 4×4 square, not a fleck.
      g.lineStyle(1, ENEMY_SHOT_TINT, 1);
      g.strokeRect(m.x0 + e.x * m.sx - 2, m.y0 + e.y * m.sy - 2, 4, 4);
    } else {
      g.fillStyle(ENEMY_SHOT_TINT, 1);
      g.fillRect(m.x0 + e.x * m.sx - 1, m.y0 + e.y * m.sy - 1, 2, 2);
    }
  }
  // qa-010: the UFO piñata is findable — blinking white saucer marker.
  const { ufo } = w;
  if (ufo && inWorld(ufo.x, ufo.y, 0, m.pw, m.ph) && Math.floor(now / 250) % 2 === 0) {
    g.lineStyle(1, 0xff_ff_ff, 1);
    g.strokeCircle(m.x0 + ufo.x * m.sx, m.y0 + ufo.y * m.sy, 2.5);
  }
  const { beacon } = w;
  if (beacon && now < beacon.diesAt) {
    const r = 3 + Math.sin((now / 1000) * Math.PI * 2) * 1.2;
    const bx = m.x0 + beacon.x * m.sx;
    const by = m.y0 + beacon.y * m.sy;
    g.lineStyle(1, BEACON_TINT, 1);
    g.beginPath();
    g.moveTo(bx, by - r);
    g.lineTo(bx + r * 0.7, by);
    g.lineTo(bx, by + r);
    g.lineTo(bx - r * 0.7, by);
    g.closePath();
    g.strokePath();
  }
};

/** Item dot in its tint; boosters are 2px diamonds so the third shell shape
 *  reads on the minimap too. */
export const drawMinimapItem = (
  g: Phaser.GameObjects.Graphics,
  it: ItemState,
  m: MinimapFrame,
): void => {
  g.fillStyle(itemTint(it), 1);
  const px = m.x0 + it.x * m.sx;
  const py = m.y0 + it.y * m.sy;
  if (it.kind === "booster") {
    g.beginPath();
    g.moveTo(px, py - 2);
    g.lineTo(px + 2, py);
    g.lineTo(px, py + 2);
    g.lineTo(px - 2, py);
    g.closePath();
    g.fillPath();
  } else {
    g.fillCircle(px, py, 1.5);
  }
};
