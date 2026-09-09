import * as THREE from "three";

const SIGN_COLS = 4;
const SIGN_ROWS = 8;
const SIGN_CELL = 128;

/**
 * One 512×512 atlas holding every pier number, so all the boards are a single
 * textured draw. Returns null where there is no DOM (the headless world tools),
 * and the boards are simply skipped.
 */
export const signAtlas = (numbers: readonly number[]): THREE.Texture | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_COLS * SIGN_CELL;
  canvas.height = SIGN_ROWS * (SIGN_CELL / 2);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = "#1d2b36";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [i, n] of numbers.entries()) {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const x = col * SIGN_CELL;
    const y = row * (SIGN_CELL / 2);
    ctx.fillStyle = "#f4f1e8";
    ctx.fillRect(x + 3, y + 3, SIGN_CELL - 6, SIGN_CELL / 2 - 6);
    ctx.fillStyle = "#1d2b36";
    ctx.font = `600 ${SIGN_CELL * 0.19}px system-ui, sans-serif`;
    ctx.fillText("PIER", x + SIGN_CELL / 2, y + SIGN_CELL * 0.16);
    ctx.font = `700 ${SIGN_CELL * 0.3}px system-ui, sans-serif`;
    ctx.fillText(String(n), x + SIGN_CELL / 2, y + SIGN_CELL * 0.34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
};

/** Accumulates the numbered boards into one textured mesh. */
export class SignBoards {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];

  /** A board `w`×`h`, centred at (x, y, z), facing (nx, nz) in the XZ plane. */
  push(
    cell: number,
    x: number,
    y: number,
    z: number,
    nx: number,
    nz: number,
    w: number,
    h: number,
  ): void {
    // Board-right, for a reader standing in front of it: cross(-n, up). Get
    // this backwards and the board is either back-facing or mirror-written.
    const ax = nz * (w / 2);
    const az = -nx * (w / 2);
    const u0 = (cell % SIGN_COLS) / SIGN_COLS;
    const v1 = 1 - Math.floor(cell / SIGN_COLS) / SIGN_ROWS;
    const u1 = u0 + 1 / SIGN_COLS;
    const v0 = v1 - 1 / SIGN_ROWS;
    const corners: readonly (readonly [number, number, number, number, number])[] = [
      [x - ax, y - h / 2, z - az, u0, v0],
      [x + ax, y - h / 2, z + az, u1, v0],
      [x + ax, y + h / 2, z + az, u1, v1],
      [x - ax, y + h / 2, z - az, u0, v1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = corners[i];
      if (!c) {
        continue;
      }
      this.pos.push(c[0], c[1], c[2]);
      this.nor.push(nx, 0, nz);
      this.uv.push(c[3], c[4]);
    }
  }

  mesh(tex: THREE.Texture): THREE.Mesh | null {
    if (this.pos.length === 0) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  }
}
