import { GRID_X, GRID_Z, ROAD_TILE, WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { CityPlan } from "../world/grid";
import type { SurfaceDeck } from "../world/city";
import { districtAt } from "../world/sf-map";

// Corner minimap: a north-up map of SF painted once from the city plan
// (water/land/parks/roads + drivable decks), with live markers composited
// over it each frame — waiting fares (tier colors), the destination, and
// the taxi as a heading arrow.

export type MinimapMarker = {
  readonly x: number;
  readonly z: number;
  readonly color: string;
  readonly ring?: boolean; // destination gets a pulsing ring
};

const WATER = "#2e5f8a";
const LAND = "#a3a49b";
const PARK = "#6f9455";
const ROAD = "#c9cdd2";
const DECK = "#c0483c";

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private base: HTMLCanvasElement;
  private size: number;
  private dpr: number;
  private t = 0;
  // Uniform fit of the rectangular world into the square canvas (letterboxed).
  private scale: number;
  private offX: number;
  private offZ: number;

  // World → canvas pixel, preserving the map's real aspect ratio.
  private pxX(x: number): number {
    return (x + WORLD_HALF_X) * this.scale + this.offX;
  }
  private pxZ(z: number): number {
    return (z + WORLD_HALF_Z) * this.scale + this.offZ;
  }

  constructor(plan: CityPlan, decks: readonly SurfaceDeck[]) {
    const node = document.getElementById("minimap");
    this.canvas = node instanceof HTMLCanvasElement ? node : document.createElement("canvas");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : 148;
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.ctx = this.canvas.getContext("2d");

    // Fit the wider (E-W) axis to the canvas, centre the shorter axis vertically.
    this.scale = this.size / Math.max(WORLD_W, WORLD_H);
    this.offX = (this.size - WORLD_W * this.scale) / 2;
    this.offZ = (this.size - WORLD_H * this.scale) / 2;
    const cell = ROAD_TILE * this.scale;

    // Paint the static base once.
    this.base = document.createElement("canvas");
    this.base.width = this.size * this.dpr;
    this.base.height = this.size * this.dpr;
    const b = this.base.getContext("2d");
    if (b) {
      b.scale(this.dpr, this.dpr);
      for (let gx = 0; gx < GRID_X; gx++) {
        for (let gz = 0; gz < GRID_Z; gz++) {
          const kind = plan.cells[gx]?.[gz];
          let fill = WATER;
          if (kind === "road") fill = ROAD;
          else if (kind === "lot") {
            fill = districtAt(gx, gz).character === "park" ? PARK : LAND;
          }
          b.fillStyle = fill;
          b.fillRect(gx * cell + this.offX, gz * cell + this.offZ, cell + 0.5, cell + 0.5);
        }
      }
      // Drivable decks (Golden Gate + wharf piers) read as landmarks.
      b.fillStyle = DECK;
      for (const d of decks) {
        b.fillRect(
          this.pxX(d.minX),
          this.pxZ(d.minZ),
          Math.max(2, (d.maxX - d.minX) * this.scale),
          Math.max(2, (d.maxZ - d.minZ) * this.scale),
        );
      }
    }
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? "block" : "none";
  }

  update(dt: number, carX: number, carZ: number, heading: number, markers: readonly MinimapMarker[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.t += dt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    for (const m of markers) {
      const px = this.pxX(m.x);
      const pz = this.pxZ(m.z);
      if (m.ring) {
        const pulse = 3.4 + Math.sin(this.t * 5) * 1.2;
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(px, pz, pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(px, pz, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // The taxi: a heading arrow. Screen up is -Z (north); heading 0 faces +Z.
    const cx = this.pxX(carX);
    const cz = this.pxZ(carZ);
    ctx.save();
    ctx.translate(cx, cz);
    ctx.rotate(Math.PI - heading);
    ctx.fillStyle = "#ffd147";
    ctx.strokeStyle = "#14111a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(3.6, 4);
    ctx.lineTo(0, 2.1);
    ctx.lineTo(-3.6, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
