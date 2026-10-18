import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { RoadNetwork } from "../world/network";
import { BASE_PX, ROUTE, paintCity } from "./minimap";
import type { MinimapMarker } from "./minimap";
import type { CityPlan } from "../world/grid";
import type { SurfaceDeck } from "../world/city";

// The big map: click the corner minimap and the whole city opens full screen.
// Drag (or one finger) pans, wheel (or pinch) zooms, and a click on a street
// hands that point to the autopilot, which drives the taxi there. The sim keeps
// running underneath — touching the controls takes the wheel back.

export interface MapSnapshot {
  readonly carX: number;
  readonly carZ: number;
  readonly heading: number;
  readonly markers: readonly MinimapMarker[];
  readonly route: Float64Array | null;
  readonly destination: { readonly x: number; readonly z: number } | null;
}

export interface MapOverlayOptions {
  readonly plan: CityPlan;
  readonly decks: readonly SurfaceDeck[];
  readonly network: RoadNetwork;
  readonly snapshot: () => MapSnapshot;
  /** A snapped street point was clicked: start driving there. */
  readonly pick: (x: number, z: number) => void;
}

const STYLE_ID = "waymo-map-style";
const CSS = `
#map-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: none;
  background: #3a9fe0;
  touch-action: none;
  font-family: var(--fd);
  font-weight: 700;
  color: #fff4e2;
  text-shadow: var(--ring-s);
}
#map-overlay.open { display: block; }
#map-overlay canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
#map-overlay canvas.drag { cursor: grabbing; }
/* The hint keeps clear of the top-right corner, where touch devices get the
   embed's pause button above everything (--vg-touch-reserve is its width). */
#map-overlay .mo-hint {
  position: absolute;
  top: calc(14px + env(safe-area-inset-top));
  left: calc(14px + env(safe-area-inset-left));
  right: calc(14px + env(safe-area-inset-right) + var(--vg-touch-reserve, 0px));
  font-size: clamp(12px, 1.9vmin, 18px);
  letter-spacing: 0.08em;
  pointer-events: none;
}
/* Close sits bottom-centre: under a thumb, and away from both pause
   buttons (embed top-right on touch, the wrapper's bottom-left). */
#map-overlay .mo-actions {
  position: absolute;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
}
#map-overlay button {
  pointer-events: auto;
  font: inherit;
  font-size: clamp(12px, 1.8vmin, 16px);
  letter-spacing: 0.06em;
  color: #1b1428;
  background: #ffd147;
  border: 2px solid #1b1428;
  border-radius: 12px;
  padding: 10px 18px;
  min-height: 48px;
  white-space: nowrap;
  cursor: pointer;
  text-shadow: none;
}
`;

const LAND_ROAD = "#fff4e2";
const DRAG_PX = 6;
const SNAP_RADIUS = 80;
// World units across the shorter screen side when the map opens.
const OPEN_SPAN = 900;
const MAX_ZOOM = 6;
const HINT = window.matchMedia("(pointer: fine)").matches
  ? "CLICK A STREET TO DRIVE THERE · DRAG TO PAN · TAB TO CLOSE"
  : "TAP A STREET TO DRIVE THERE · DRAG TO PAN";

interface Pointer {
  x: number;
  y: number;
}

interface WorldPoint {
  readonly x: number;
  readonly z: number;
}

const tracePath = (ctx: CanvasRenderingContext2D, route: Float64Array): void => {
  ctx.beginPath();
  ctx.moveTo(route[0] ?? 0, route[1] ?? 0);
  for (let k = 2; k + 1 < route.length; k += 2) {
    ctx.lineTo(route[k] ?? 0, route[k + 1] ?? 0);
  }
  ctx.stroke();
};

export class MapOverlay {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly hint: HTMLSpanElement;
  private readonly opts: MapOverlayOptions;
  // ground without streets; the streets are vectors drawn over it
  private readonly ground: HTMLCanvasElement;
  // street paths keyed by their width in world units
  private readonly roads = new Map<number, Path2D>();
  private readonly pointers = new Map<number, Pointer>();
  // view: world point at screen centre, CSS px per world unit
  private cx = 0;
  private cz = 0;
  private zoom = 1;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private dragged = false;
  private travel = 0;
  private hover: WorldPoint | null = null;
  private raf = 0;
  private t = 0;
  private hintTimer = 0;

  constructor(opts: MapOverlayOptions) {
    this.opts = opts;
    if (!document.querySelector(`#${STYLE_ID}`)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    this.root = document.createElement("div");
    this.root.id = "map-overlay";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "City map");
    // Touch: a finger here pans the map, never anchors the steering stick.
    this.root.dataset.gamepadIgnore = "";
    this.canvas = document.createElement("canvas");
    const actions = document.createElement("div");
    actions.className = "mo-actions";
    this.hint = document.createElement("span");
    this.hint.className = "mo-hint";
    this.hint.textContent = HINT;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mo-close";
    close.textContent = "✕ CLOSE MAP";
    actions.append(close);
    this.root.append(this.canvas, this.hint, actions);
    document.body.append(this.root);
    this.ctx = this.canvas.getContext("2d");

    this.ground = document.createElement("canvas");
    paintCity(this.ground, opts.plan, opts.decks, BASE_PX / Math.max(WORLD_W, WORLD_H), false);
    // Every street once, bucketed by width: crisp at any zoom, unlike cell paint.
    for (const e of opts.network.edges) {
      const width = Math.max(4, Math.round(e.half * 2));
      let path = this.roads.get(width);
      if (!path) {
        path = new Path2D();
        this.roads.set(width, path);
      }
      path.moveTo(e.pts[0] ?? 0, e.pts[1] ?? 0);
      for (let k = 2; k + 1 < e.pts.length; k += 2) {
        path.lineTo(e.pts[k] ?? 0, e.pts[k + 1] ?? 0);
      }
    }

    close.addEventListener("click", () => this.close());
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onCancel);
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
    });
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (this.isOpen && e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    window.addEventListener("resize", () => {
      if (this.isOpen) {
        this.resize();
      }
    });
  }

  get isOpen(): boolean {
    return this.root.classList.contains("open");
  }

  open(): void {
    if (this.isOpen) {
      return;
    }
    this.root.classList.add("open");
    this.resize();
    const snap = this.opts.snapshot();
    this.cx = snap.carX;
    this.cz = snap.carZ;
    this.zoom = this.clampZoom(Math.min(this.w, this.h) / OPEN_SPAN);
    this.setHint(HINT);
    const tick = (): void => {
      this.t += 1 / 60;
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.root.classList.remove("open");
    cancelAnimationFrame(this.raf);
    this.pointers.clear();
    this.hover = null;
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  private clampZoom(z: number): number {
    // Zoomed out no further than the whole city with a margin round it.
    const min = Math.min(this.w / WORLD_W, this.h / WORLD_H) * 0.9;
    return Math.min(MAX_ZOOM, Math.max(min, z));
  }

  private toWorld(sx: number, sy: number): WorldPoint {
    return {
      x: this.cx + (sx - this.w / 2) / this.zoom,
      z: this.cz + (sy - this.h / 2) / this.zoom,
    };
  }

  private toScreen(x: number, z: number): Pointer {
    return { x: (x - this.cx) * this.zoom + this.w / 2, y: (z - this.cz) * this.zoom + this.h / 2 };
  }

  /** Zoom by `factor` keeping the world point under (sx, sy) where it is. */
  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = this.clampZoom(this.zoom * factor);
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
  }

  private snap(sx: number, sy: number): WorldPoint | null {
    const at = this.toWorld(sx, sy);
    const hit = this.opts.network.nearest(at.x, at.z, Math.max(SNAP_RADIUS, 24 / this.zoom));
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  private setHint(text: string, ms = 0): void {
    this.hint.textContent = text;
    window.clearTimeout(this.hintTimer);
    if (ms > 0) {
      this.hintTimer = window.setTimeout(() => {
        this.hint.textContent = HINT;
      }, ms);
    }
  }

  private local(e: MouseEvent): Pointer {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 1) {
      this.dragged = false;
      this.travel = 0;
    } else {
      // A second finger makes this a pinch, never a pick.
      this.dragged = true;
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      // Mouse hover: preview the street point a click would pick.
      if (e.pointerType === "mouse") {
        this.hover = this.snap(p.x, p.y);
      }
      return;
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const other = a === prev ? b : a;
      if (other) {
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(p.x - other.x, p.y - other.y);
        if (before > 1) {
          this.zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, after / before);
        }
      }
      // The midpoint moves by half of this finger's motion.
      this.cx -= (p.x - prev.x) / 2 / this.zoom;
      this.cz -= (p.y - prev.y) / 2 / this.zoom;
    } else {
      this.travel += Math.hypot(p.x - prev.x, p.y - prev.y);
      if (this.travel > DRAG_PX) {
        this.dragged = true;
        this.canvas.classList.add("drag");
      }
      if (this.dragged) {
        this.cx -= (p.x - prev.x) / this.zoom;
        this.cz -= (p.y - prev.y) / this.zoom;
      }
    }
    prev.x = p.x;
    prev.y = p.y;
    this.hover = null;
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.local(e);
    const tap = this.pointers.size === 1 && !this.dragged;
    this.pointers.delete(e.pointerId);
    this.canvas.classList.remove("drag");
    if (!tap) {
      return;
    }
    const at = this.snap(p.x, p.y);
    if (!at) {
      this.setHint("NO STREET THERE — TAP A ROAD", 1600);
      return;
    }
    this.opts.pick(at.x, at.z);
    this.close();
  };

  private onCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.canvas.classList.remove("drag");
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  };

  private draw(): void {
    const { ctx } = this;
    if (!ctx) {
      return;
    }
    const snap = this.opts.snapshot();
    // Keep the view over the city.
    this.cx = Math.min(WORLD_HALF_X, Math.max(-WORLD_HALF_X, this.cx));
    this.cz = Math.min(WORLD_HALF_Z, Math.max(-WORLD_HALF_Z, this.cz));

    const { dpr, zoom } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#3a9fe0";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // World space: 1 unit = zoom CSS px.
    ctx.setTransform(
      dpr * zoom,
      0,
      0,
      dpr * zoom,
      dpr * (this.w / 2 - this.cx * zoom),
      dpr * (this.h / 2 - this.cz * zoom),
    );
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.ground, -WORLD_HALF_X, -WORLD_HALF_Z, WORLD_W, WORLD_H);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = LAND_ROAD;
    for (const [width, path] of this.roads) {
      ctx.lineWidth = Math.max(width, 1.5 / zoom);
      ctx.stroke(path);
    }

    const { route } = snap;
    if (route && route.length >= 4) {
      ctx.strokeStyle = "#1b1428";
      ctx.lineWidth = 9 / zoom;
      tracePath(ctx, route);
      ctx.strokeStyle = ROUTE;
      ctx.lineWidth = 5 / zoom;
      tracePath(ctx, route);
    }

    // Screen space for the glyphs: constant size at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const m of snap.markers) {
      const s = this.toScreen(m.x, m.z);
      ctx.fillStyle = m.color;
      ctx.strokeStyle = "#1b1428";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (m.glyph === "square") {
        ctx.rect(s.x - 5, s.y - 5, 10, 10);
      } else {
        ctx.arc(s.x, s.y, m.glyph === "player" ? 5 : 6, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      if (m.ring) {
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 10 + Math.sin(this.t * 5) * 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (snap.destination) {
      this.flag(ctx, snap.destination.x, snap.destination.z, ROUTE);
    }
    if (this.hover) {
      const s = this.toScreen(this.hover.x, this.hover.z);
      ctx.strokeStyle = "#1b1428";
      ctx.fillStyle = "rgba(107, 255, 142, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // The taxi, as the minimap draws it but bigger. Screen up is -Z; heading 0 faces +Z.
    const car = this.toScreen(snap.carX, snap.carZ);
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(Math.PI - snap.heading);
    ctx.fillStyle = "#ffd147";
    ctx.strokeStyle = "#1b1428";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8.5, 9);
    ctx.lineTo(0, 4.5);
    ctx.lineTo(-8.5, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private flag(ctx: CanvasRenderingContext2D, x: number, z: number, color: string): void {
    const s = this.toScreen(x, z);
    ctx.strokeStyle = "#1b1428";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x, s.y - 26);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 26);
    ctx.lineTo(s.x + 16, s.y - 20);
    ctx.lineTo(s.x, s.y - 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
