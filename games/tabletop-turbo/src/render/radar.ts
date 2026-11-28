import { edgeDistance } from "../sim/arena";
import type { Arena } from "../sim/arena";

/** One thing on the radar: where it is in the world and what it is painted in. */
export interface Blip {
  x: number;
  z: number;
  /** 0xRRGGBB. */
  rgb: number;
  /** Drawn a pixel bigger: the cars. */
  big: boolean;
}

const SIZE = 48;
const REACH = 46;
const FLOOR = 0xc9_b8_9a;
const RIM = 0x9a_8c_7c;
const VOID = 0x1e_1d_2d;
const SELF = 0xff_f0_c8;

/**
 * A round map of the board about the player, turned the way the camera is
 * turned: up the radar is up the screen.
 */
export class Radar {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly image: ImageData;
  private readonly floor = new Uint8Array(SIZE * SIZE);
  private frame = 0;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    this.ctx = canvas.getContext("2d");
    this.image = new ImageData(SIZE, SIZE);
  }

  /**
   * `yaw` is the heading that points up the screen. `late` is the board with
   * its rim gone, `warn` the moment before, when the rim is shown going.
   */
  draw(
    arena: Arena,
    at: { x: number; z: number },
    yaw: number,
    late: boolean,
    warn: boolean,
    blips: readonly Blip[],
  ) {
    const { ctx, image } = this;

    if (!ctx) {
      return;
    }

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const scale = (REACH * 2) / SIZE;
    this.frame += 1;

    if (this.frame % 3 === 1) {
      this.scan(arena, at, cos, sin, scale, late, warn);
    }

    const { data } = image;

    for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
      const kind = this.floor[cell] ?? 0;
      const rgb = kind === 2 ? RIM : FLOOR;
      const shown = kind === 0 ? VOID : rgb;
      const round = kind === 3 ? 0 : 255;
      data[cell * 4] = Math.floor(shown / 65_536);
      data[cell * 4 + 1] = Math.floor(shown / 256) % 256;
      data[cell * 4 + 2] = shown % 256;
      data[cell * 4 + 3] = kind === 0 ? Math.min(round, 150) : round;
    }

    for (const blip of blips) {
      const dx = blip.x - at.x;
      const dz = blip.z - at.z;
      const up = (dx * cos + dz * sin) / scale;
      const right = (-dx * sin + dz * cos) / scale;
      const far = Math.hypot(up, right);
      const pull = far > SIZE / 2 - 2 ? (SIZE / 2 - 2) / far : 1;
      this.dot(SIZE / 2 + right * pull, SIZE / 2 - up * pull, blip.rgb, blip.big ? 3 : 2);
    }

    this.dot(SIZE / 2, SIZE / 2, SELF, 3);
    this.dot(SIZE / 2, SIZE / 2 - 2.5, SELF, 1);
    ctx.putImageData(image, 0, 0);
  }

  private scan(
    arena: Arena,
    at: { x: number; z: number },
    cos: number,
    sin: number,
    scale: number,
    late: boolean,
    warn: boolean,
  ) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const right = (col + 0.5 - SIZE / 2) * scale;
        const up = (SIZE / 2 - row - 0.5) * scale;
        const x = at.x + up * cos - right * sin;
        const z = at.z + up * sin + right * cos;
        const inside = Math.hypot(right, up) < REACH;
        let kind = 3;

        if (inside) {
          const core = edgeDistance(arena, x, z, true) > 0;
          const rim = !core && !late && edgeDistance(arena, x, z, false) > 0;
          const going = warn ? 2 : 1;
          kind = core ? 1 : 0;
          kind = rim ? going : kind;
        }

        this.floor[row * SIZE + col] = kind;
      }
    }
  }

  private dot(x: number, y: number, rgb: number, size: number) {
    const { data } = this.image;
    const x0 = Math.round(x - size / 2);
    const y0 = Math.round(y - size / 2);

    for (let j = y0; j < y0 + size; j += 1) {
      for (let i = x0; i < x0 + size; i += 1) {
        if (i >= 0 && j >= 0 && i < SIZE && j < SIZE) {
          const cell = (j * SIZE + i) * 4;
          data[cell] = Math.floor(rgb / 65_536);
          data[cell + 1] = Math.floor(rgb / 256) % 256;
          data[cell + 2] = rgb % 256;
          data[cell + 3] = 255;
        }
      }
    }
  }
}
