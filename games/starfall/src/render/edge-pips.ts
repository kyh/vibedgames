/**
 * Viewport-edge pips — the ONE reusable off-screen indicator the spec mandates
 * (dir-004): a small neon-wireframe glyph clamped just inside the camera view,
 * pointing at a world-space target the player can't currently see. Shared by
 * the BEACON (gold hollow diamond), the UFO (blinking hollow circle, qa-010)
 * and the debut-wave threat pips (red triangles, qa-007).
 *
 * Drawn in WORLD space on the target scene's camera: positions clamp into the
 * camera's worldView and sizes scale by 1/zoom, so a pip reads the same
 * screen size at any zoom (phones floor at 0.75).
 */

import Phaser from "phaser";

import { PIP_EDGE_MARGIN, PIP_SIZE } from "../shared/constants";

export type PipShape = "diamond" | "triangle" | "circle";

export type PipTarget = {
  x: number;
  y: number;
  tint: number;
  shape: PipShape;
  /** 2Hz blink (UFO marker language). */
  blink?: boolean;
};

export class EdgePips {
  private gfx: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, depth: number) {
    this.gfx = scene.add.graphics().setDepth(depth).setBlendMode(Phaser.BlendModes.ADD);
  }

  /** Redraw all pips for this frame. Targets already on-viewport are skipped. */
  draw(cam: Phaser.Cameras.Scene2D.Camera, targets: ReadonlyArray<PipTarget>, now: number): void {
    const g = this.gfx;
    g.clear();
    if (targets.length === 0) return;
    const view = cam.worldView;
    const s = 1 / Math.max(0.01, cam.zoom); // screen px → world px
    const margin = PIP_EDGE_MARGIN * s;
    const size = PIP_SIZE * s;
    for (const t of targets) {
      // On-viewport targets need no pip (small slack so a pip doesn't pop the
      // exact frame the target's center crosses the edge).
      if (
        t.x >= view.x - 20 &&
        t.x <= view.right + 20 &&
        t.y >= view.y - 20 &&
        t.y <= view.bottom + 20
      ) {
        continue;
      }
      if (t.blink && Math.floor(now / 250) % 2 === 1) continue;
      const px = Phaser.Math.Clamp(t.x, view.x + margin, view.right - margin);
      const py = Phaser.Math.Clamp(t.y, view.y + margin, view.bottom - margin);
      const ang = Math.atan2(t.y - py, t.x - px);
      if (t.shape === "triangle") {
        // Filled arrowhead pointing at the target.
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        g.fillStyle(t.tint, 0.9);
        g.beginPath();
        g.moveTo(px + cos * size, py + sin * size);
        g.lineTo(px - sin * size * 0.55 - cos * size * 0.6, py + cos * size * 0.55 - sin * size * 0.6);
        g.lineTo(px + sin * size * 0.55 - cos * size * 0.6, py - cos * size * 0.55 - sin * size * 0.6);
        g.closePath();
        g.fillPath();
      } else if (t.shape === "diamond") {
        // Hollow diamond + a tick toward the target (beacon language).
        g.lineStyle(2 * s, t.tint, 0.9);
        g.beginPath();
        g.moveTo(px, py - size);
        g.lineTo(px + size * 0.7, py);
        g.lineTo(px, py + size);
        g.lineTo(px - size * 0.7, py);
        g.closePath();
        g.strokePath();
        g.lineBetween(
          px + Math.cos(ang) * size,
          py + Math.sin(ang) * size,
          px + Math.cos(ang) * size * 1.6,
          py + Math.sin(ang) * size * 1.6,
        );
      } else {
        // Hollow circle + tick (UFO language).
        g.lineStyle(2 * s, t.tint, 0.9);
        g.strokeCircle(px, py, size * 0.7);
        g.lineBetween(
          px + Math.cos(ang) * size * 0.7,
          py + Math.sin(ang) * size * 0.7,
          px + Math.cos(ang) * size * 1.4,
          py + Math.sin(ang) * size * 1.4,
        );
      }
    }
  }
}
