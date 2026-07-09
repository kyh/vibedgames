import { GRID_X, GRID_Z, WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { CityPlan } from "../world/grid";
import type { SurfaceDeck } from "../world/city";
import { districtAt } from "../world/sf-map";

// Corner minimap: a ZOOMED north-up viewport (~VIEW world units across)
// following the taxi — the full-map view made streets unreadably small at SF
// scale. The whole map is painted once into a high-res offscreen base; each
// frame blits the window around the car and composites live markers: waiting
// fares (tier colors), the destination, and the taxi as a heading arrow.
// Off-window markers clamp to the edge so you always know which way to go.

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

// World units across the minimap window. Mobile zooms in: the canvas is ~2/3
// the desktop size, so the same VIEW would shrink streets below legibility.
const VIEW_DESKTOP = 560;
const VIEW_MOBILE = 340;
const BASE_PX = 2048; // offscreen full-map resolution (px on the long axis)

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private base: HTMLCanvasElement;
  private size: number;
  private dpr: number;
  private t = 0;
  private baseScale: number; // world units → base px
  private view: number;

  constructor(plan: CityPlan, decks: readonly SurfaceDeck[]) {
    const node = document.getElementById("minimap");
    this.canvas = node instanceof HTMLCanvasElement ? node : document.createElement("canvas");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.view = window.matchMedia("(pointer: coarse)").matches ? VIEW_MOBILE : VIEW_DESKTOP;
    this.size = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : 148;
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.ctx = this.canvas.getContext("2d");

    // Paint the static base once, at high resolution so the zoom window
    // stays crisp (VIEW window → this.size px needs ~0.6 px/u; we bake 0.65).
    this.baseScale = BASE_PX / Math.max(WORLD_W, WORLD_H);
    this.base = document.createElement("canvas");
    this.base.width = Math.ceil(WORLD_W * this.baseScale);
    this.base.height = Math.ceil(WORLD_H * this.baseScale);
    const b = this.base.getContext("2d");
    if (b) {
      const cellX = (WORLD_W * this.baseScale) / GRID_X;
      const cellZ = (WORLD_H * this.baseScale) / GRID_Z;
      for (let gx = 0; gx < GRID_X; gx++) {
        for (let gz = 0; gz < GRID_Z; gz++) {
          const kind = plan.cells[gx]?.[gz];
          let fill = WATER;
          if (kind === "road") fill = ROAD;
          else if (kind === "lot") {
            fill = districtAt(gx, gz).character === "park" ? PARK : LAND;
          }
          b.fillStyle = fill;
          b.fillRect(gx * cellX, gz * cellZ, cellX + 0.5, cellZ + 0.5);
        }
      }
      // Drivable decks (Golden Gate + wharf piers) read as landmarks.
      b.fillStyle = DECK;
      for (const d of decks) {
        b.fillRect(
          (d.minX + WORLD_HALF_X) * this.baseScale,
          (d.minZ + WORLD_HALF_Z) * this.baseScale,
          Math.max(2, (d.maxX - d.minX) * this.baseScale),
          Math.max(2, (d.maxZ - d.minZ) * this.baseScale),
        );
      }
    }
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? "block" : "none";
  }

  update(
    dt: number,
    carX: number,
    carZ: number,
    heading: number,
    markers: readonly MinimapMarker[],
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.t += dt;

    // Blit the window around the car (base px), water-blue beyond the map.
    const winPx = this.view * this.baseScale;
    const sx = (carX + WORLD_HALF_X) * this.baseScale - winPx / 2;
    const sz = (carZ + WORLD_HALF_Z) * this.baseScale - winPx / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = WATER;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, sx, sz, winPx, winPx, 0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // World → viewport CSS px.
    const vScale = this.size / this.view;
    const px = (x: number): number => (x - carX + this.view / 2) * vScale;
    const pz = (z: number): number => (z - carZ + this.view / 2) * vScale;

    for (const m of markers) {
      // Clamp off-window markers to the edge (direction hint).
      const rawX = px(m.x);
      const rawZ = pz(m.z);
      const mx = Math.min(this.size - 5, Math.max(5, rawX));
      const mz = Math.min(this.size - 5, Math.max(5, rawZ));
      const clamped = mx !== rawX || mz !== rawZ;
      if (m.ring && !clamped) {
        const pulse = 4 + Math.sin(this.t * 5) * 1.4;
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(mx, mz, pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(mx, mz, clamped ? 3.2 : 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // The taxi: centred heading arrow. Screen up is -Z; heading 0 faces +Z.
    ctx.save();
    ctx.translate(this.size / 2, this.size / 2);
    ctx.rotate(Math.PI - heading);
    ctx.fillStyle = "#ffd147";
    ctx.strokeStyle = "#14111a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.2, 4.6);
    ctx.lineTo(0, 2.4);
    ctx.lineTo(-4.2, 4.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
