import type { StrikeforceGame } from "./core/types";

const WORLD = { x0: -112, x1: 40, z0: -30, z1: 30 };
const CELL = 0.5;
const EDGE = 4;
const RANGE = 36;
const SIZE = 156;
const PING_S = 2.5;

const BONE = "232,228,218";
const ENEMY = "#ff5a3c";
const SIGNAL = "#ffb347";

interface Ping {
  x: number;
  z: number;
  t: number;
}

export interface RadarMark {
  x: number;
  z: number;
  label: string;
}

const dilate = (mask: Uint8Array, w: number, h: number, r: number) => {
  const rows = new Uint8Array(mask.length);

  for (let z = 0; z < h; z += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;

      for (let d = -r; d <= r && !on; d += 1) {
        on = mask[z * w + Math.min(w - 1, Math.max(0, x + d))] ?? 0;
      }

      rows[z * w + x] = on;
    }
  }

  const out = new Uint8Array(mask.length);

  for (let z = 0; z < h; z += 1) {
    for (let x = 0; x < w; x += 1) {
      let on = 0;

      for (let d = -r; d <= r && !on; d += 1) {
        on = rows[Math.min(h - 1, Math.max(0, z + d)) * w + x] ?? 0;
      }

      out[z * w + x] = on;
    }
  }

  return out;
};

const cellAlpha = (open: number | undefined, near: number | undefined) => {
  if (open) {
    return 26;
  }

  return near ? 120 : 0;
};

const bake = (game: StrikeforceGame) => {
  const w = Math.round((WORLD.x1 - WORLD.x0) / CELL);
  const h = Math.round((WORLD.z1 - WORLD.z0) / CELL);
  const open = new Uint8Array(w * h);

  for (let z = 0; z < h; z += 1) {
    for (let x = 0; x < w; x += 1) {
      const wx = WORLD.x0 + (x + 0.5) * CELL;
      const wz = WORLD.z0 + (z + 0.5) * CELL;
      open[z * w + x] = game.physics.nav.isWalkable(wx, wz) ? 1 : 0;
    }
  }

  const near = dilate(open, w, h, EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return canvas;
  }

  const img = ctx.createImageData(w, h);

  for (let i = 0; i < open.length; i += 1) {
    img.data.set([232, 228, 218, cellAlpha(open[i], near[i])], i * 4);
  }

  ctx.putImageData(img, 0, 0);

  return canvas;
};

const drawMarks = (
  ctx: CanvasRenderingContext2D,
  marks: readonly RadarMark[],
  px: number,
  pz: number,
  yaw: number,
  scale: number,
) => {
  const r = SIZE / 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  const onScreen: (dx: number, dz: number, clamp: boolean) => [number, number] = (
    dx,
    dz,
    clamp,
  ) => {
    let sx = (dx * cos - dz * sin) * scale;
    let sy = (dx * sin + dz * cos) * scale;
    const len = Math.hypot(sx, sy);
    const rim = r - 9;

    if (clamp && len > rim) {
      sx *= rim / len;
      sy *= rim / len;
    }

    return [r + sx, r + sy];
  };

  ctx.font = '700 10px "Big Shoulders Display", Impact, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const [nx, ny] = onScreen(0, -1e4, true);
  ctx.fillStyle = `rgba(${BONE},0.7)`;
  ctx.fillText("N", nx, ny);

  for (const m of marks) {
    const [mx, my] = onScreen(m.x - px, m.z - pz, true);
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(mx - 6, my - 6, 12, 12);
    ctx.fillStyle = "#0b0d0f";
    ctx.fillText(m.label, mx, my + 0.5);
  }
};

const drawSelf = (ctx: CanvasRenderingContext2D, r: number) => {
  ctx.beginPath();
  ctx.moveTo(r, r - 7);
  ctx.lineTo(r + 5, r + 5);
  ctx.lineTo(r, r + 2.5);
  ctx.lineTo(r - 5, r + 5);
  ctx.closePath();
  ctx.fillStyle = SIGNAL;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${BONE},0.22)`;
  ctx.lineWidth = 1;
  ctx.stroke();
};

export class Radar {
  private readonly root: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private map: HTMLCanvasElement | null = null;
  private pings: Ping[] = [];
  private dpr = 1;

  constructor() {
    this.root = document.createElement("canvas");
    this.root.className = "radar";
    this.root.setAttribute("aria-hidden", "true");
    this.ctx = this.root.getContext("2d");
  }

  mount() {
    document.querySelector("#ui")?.append(this.root);
  }

  /** An enemy fired from here. */
  ping(x: number, z: number, t: number) {
    this.pings.push({ t, x, z });
  }

  update(game: StrikeforceGame, shown: boolean, marks: readonly RadarMark[]) {
    this.root.classList.toggle("on", shown);
    const { ctx } = this;

    if (!shown || !ctx) {
      return;
    }

    this.map ??= bake(game);
    this.fit();
    const now = game.time.t;
    this.pings = this.pings.filter((p) => now - p.t < PING_S);
    const { pos, yaw } = game.player;
    const r = SIZE / 2;
    const scale = r / RANGE;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(11,13,15,0.72)";
    ctx.fill();
    ctx.clip();
    ctx.translate(r, r);
    ctx.scale(scale, scale);
    ctx.rotate(yaw);
    ctx.translate(-pos.x, -pos.z);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.map, WORLD.x0, WORLD.z0, WORLD.x1 - WORLD.x0, WORLD.z1 - WORLD.z0);

    for (const p of this.pings) {
      const k = 1 - (now - p.t) / PING_S;
      ctx.beginPath();
      ctx.arc(p.x, p.z, 1.6 + (1 - k) * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = ENEMY;
      ctx.globalAlpha = k;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
    drawMarks(ctx, marks, pos.x, pos.z, yaw, scale);
    drawSelf(ctx, r);
  }

  private fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (dpr === this.dpr && this.root.width === SIZE * dpr) {
      return;
    }

    this.dpr = dpr;
    this.root.width = SIZE * dpr;
    this.root.height = SIZE * dpr;
  }
}
