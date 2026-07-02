import { GRID, WORLD_SIZE } from "../shared/constants";
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

function toPx(coord: number, size: number): number {
  return (coord / WORLD_SIZE + 0.5) * size;
}

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private base: HTMLCanvasElement;
  private size: number;
  private dpr: number;
  private t = 0;

  constructor(plan: CityPlan, decks: readonly SurfaceDeck[]) {
    const node = document.getElementById("minimap");
    this.canvas = node instanceof HTMLCanvasElement ? node : document.createElement("canvas");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : 148;
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.ctx = this.canvas.getContext("2d");

    // Paint the static base once.
    this.base = document.createElement("canvas");
    this.base.width = this.size * this.dpr;
    this.base.height = this.size * this.dpr;
    const b = this.base.getContext("2d");
    if (b) {
      b.scale(this.dpr, this.dpr);
      const cell = this.size / GRID;
      for (let gx = 0; gx < GRID; gx++) {
        for (let gz = 0; gz < GRID; gz++) {
          const kind = plan.cells[gx]?.[gz];
          let fill = WATER;
          if (kind === "road") fill = ROAD;
          else if (kind === "lot") {
            fill = districtAt(gx, gz).character === "park" ? PARK : LAND;
          }
          b.fillStyle = fill;
          b.fillRect(gx * cell, gz * cell, cell + 0.5, cell + 0.5);
        }
      }
      // Drivable decks (Golden Gate + wharf piers) read as landmarks.
      b.fillStyle = DECK;
      for (const d of decks) {
        b.fillRect(
          toPx(d.minX, this.size),
          toPx(d.minZ, this.size),
          Math.max(2, ((d.maxX - d.minX) / WORLD_SIZE) * this.size),
          Math.max(2, ((d.maxZ - d.minZ) / WORLD_SIZE) * this.size),
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
      const px = toPx(m.x, this.size);
      const pz = toPx(m.z, this.size);
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
    const cx = toPx(carX, this.size);
    const cz = toPx(carZ, this.size);
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
