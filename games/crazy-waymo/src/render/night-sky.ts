import * as THREE from "three";

// The night dome. Below the horizon the physical Sky shader returns black, so
// the night used to swap `scene.background` for ONE flat colour (the fog color
// dimmed). That blends into the fog line perfectly and is otherwise dead: half
// of every night frame was a single value with nothing in it — no gradient, no
// stars, no moon. This paints that half instead.
//
// It is an equirectangular CANVAS, not a shader dome, for one reason: the dome
// would have to be added to the scene by the scene owner, while `background`
// is already DayNight's to set. The cost is a re-bake whenever the night fog
// color drifts far enough to matter (REBAKE_EPS), which over a real SF night is
// a handful of times an hour.
//
// The horizon row is painted with the CALLER's fog color, so the fog line still
// meets the dome seamlessly — the gradient only darkens going up, which is the
// direction nothing else in the frame occupies.

const W = 512;
const H = 256;
// Below this the dome is flat horizon colour: the ground covers it, and a
// gradient running past the horizon shows as a band under distant terrain.
const HORIZON_V = 0.5;
const ZENITH_MUL = 0.6; // how much of the horizon value survives at the zenith
const HORIZON_MUL = 0.78; // matches the flat background this replaced (fog * 0.72-ish)
const STARS = 700;
const REBAKE_EPS = 0.012; // per-channel fog drift that forces a re-bake

// Deterministic star field: a re-bake must not re-roll the sky.
function starRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const scratch = new THREE.Color();

function paint(ctx: CanvasRenderingContext2D, fog: THREE.Color): void {
  // getStyle(), never `r * 255`: with three's colour management on, a Color's
  // channels are LINEAR, and the canvas this paints into is read back as sRGB.
  // Writing linear bytes straight to it costs roughly a factor of three in
  // value — the whole dome came out near-black on the first pass.
  const hStyle = scratch.copy(fog).multiplyScalar(HORIZON_MUL).getStyle();
  // Zenith drifts BLUER as well as darker — a straight multiply keeps the fog's
  // hue and reads as "the same colour, dimmer", which is the flat look again.
  scratch.copy(fog).multiplyScalar(HORIZON_MUL * ZENITH_MUL);
  scratch.b = Math.min(1, scratch.b * 1.5 + 0.004);
  scratch.r *= 0.72;
  scratch.g *= 0.86;
  const zStyle = scratch.getStyle();

  const grad = ctx.createLinearGradient(0, 0, 0, H * HORIZON_V);
  grad.addColorStop(0, zStyle);
  grad.addColorStop(1, hStyle);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H * HORIZON_V);
  ctx.fillStyle = hStyle;
  ctx.fillRect(0, H * HORIZON_V, W, H - H * HORIZON_V);

  // Stars thin out toward the horizon (haze) and never sit below it.
  const rnd = starRng(0x5f3a11);
  for (let i = 0; i < STARS; i++) {
    const x = rnd() * W;
    const t = rnd(); // 0 horizon .. 1 zenith
    const y = H * HORIZON_V * (1 - t);
    const bright = rnd();
    const a = (0.18 + 0.72 * bright * bright) * (0.25 + 0.75 * t);
    const r = bright > 0.94 ? 1.5 : bright > 0.75 ? 1.0 : 0.7;
    // A touch of colour on the brightest ones; the rest stay neutral so the
    // field reads as stars and not as noise.
    const tint = bright > 0.9 ? (rnd() > 0.5 ? "255,228,205" : "205,224,255") : "255,255,255";
    ctx.fillStyle = `rgba(${tint},${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Equirectangular night dome, re-painted only when the fog colour it has to
 * meet has drifted. `null` on a canvas-less runtime (the gen worker) so the
 * caller falls back to the flat background.
 */
export class NightSky {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private tex: THREE.CanvasTexture | null = null;
  private bakedFor = new THREE.Color(-1, -1, -1);

  texture(fog: THREE.Color): THREE.Texture | null {
    if (!this.canvas) {
      if (typeof document === "undefined") return null;
      this.canvas = document.createElement("canvas");
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext("2d");
      if (!this.ctx) return null;
      this.tex = new THREE.CanvasTexture(this.canvas);
      this.tex.mapping = THREE.EquirectangularReflectionMapping;
      this.tex.colorSpace = THREE.SRGBColorSpace;
    }
    const ctx = this.ctx;
    const tex = this.tex;
    if (!ctx || !tex) return null;
    if (
      Math.abs(fog.r - this.bakedFor.r) > REBAKE_EPS ||
      Math.abs(fog.g - this.bakedFor.g) > REBAKE_EPS ||
      Math.abs(fog.b - this.bakedFor.b) > REBAKE_EPS
    ) {
      this.bakedFor.copy(fog);
      paint(ctx, fog);
      tex.needsUpdate = true;
    }
    return tex;
  }
}
