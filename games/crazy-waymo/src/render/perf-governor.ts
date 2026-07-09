import type * as THREE from "three";

// Adaptive quality: keeps the game at target frame rate by stepping render
// resolution (and, at the floor tier, shadow resolution) instead of letting it
// chug. Fill rate is the dominant cost on high-DPR screens — dropping the
// pixel ratio a notch recovers far more than any scene tweak.
//
// Decisions run on the MEDIAN frame time of ~2s windows: shader-compile and
// GC bursts are outliers a mean/EMA would absorb into a false "slow" verdict,
// but they can't move a median unless more than half the window is actually
// slow. Downgrade on one bad window; upgrade only after several consecutive
// fast ones so the tier never flaps at a boundary.

const WINDOW_FRAMES = 120; // ~1.2s at 100fps, ~2.5s at 48fps
const SPIKE_MS = 100; // tab-away / breakpoint frames: not evidence
const SLOW_MS = 21; // median worse than ~48fps → step down
// "Fast" must include a 60Hz vsync-locked median (~16.7ms) — with a 13ms bar a
// 60Hz display could downgrade once and never climb back no matter how much
// GPU headroom it has.
const FAST_MS = 17;
const UPGRADE_WINDOWS = 3; // consecutive fast windows before stepping up
// Borderline machines are fast at tier N and slow at tier N-1 — each failed
// upgrade doubles the fast-window requirement so the flapping dies out.
const UPGRADE_WINDOWS_MAX = 24;
const FLAP_WINDOW_S = 12; // a downgrade this soon after an upgrade = a flap
const COOLDOWN_S = 2.5; // settle time after a tier change
const SHADOW_FULL = 2048;
const SHADOW_LOW = 1024;

type Tier = { readonly ratio: number; readonly shadow: number };

export class PerfGovernor {
  private readonly tiers: readonly Tier[];
  private tier = 0;
  private cooldown = 1.5; // grace at boot
  private frames: number[] = [];
  private fastWindows = 0;
  private upgradeCost = UPGRADE_WINDOWS;
  private sinceUpgrade = Infinity; // seconds since the last tier-up

  constructor(
    private renderer: THREE.WebGLRenderer,
    private sun: THREE.DirectionalLight,
    private onApply: () => void,
  ) {
    const native = Math.min(window.devicePixelRatio || 1, 2);
    this.tiers = [
      { ratio: native, shadow: SHADOW_FULL },
      { ratio: Math.max(1, native * 0.8), shadow: SHADOW_FULL },
      { ratio: Math.max(0.9, native * 0.66), shadow: SHADOW_FULL },
      { ratio: Math.max(0.8, native * 0.55), shadow: SHADOW_LOW },
      { ratio: Math.max(0.7, native * 0.45), shadow: SHADOW_LOW }, // floor for weak GPUs
    ];
  }

  get currentTier(): number {
    return this.tier;
  }

  // Feed the RAW frame delta (seconds) every frame, before render.
  update(dt: number): void {
    const ms = dt * 1000;
    if (ms > SPIKE_MS) return;
    this.sinceUpgrade += dt;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    this.frames.push(ms);
    if (this.frames.length < WINDOW_FRAMES) return;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 1000 / 60;
    this.frames.length = 0;
    if (median > SLOW_MS && this.tier < this.tiers.length - 1) {
      // Downgrading right after an upgrade means the upgrade was wrong —
      // make the next attempt exponentially more patient.
      if (this.sinceUpgrade < FLAP_WINDOW_S) {
        this.upgradeCost = Math.min(UPGRADE_WINDOWS_MAX, this.upgradeCost * 2);
      }
      this.apply(this.tier + 1);
    } else if (median < FAST_MS && this.tier > 0) {
      this.fastWindows++;
      if (this.fastWindows >= this.upgradeCost) {
        this.sinceUpgrade = 0;
        this.apply(this.tier - 1);
      }
    } else {
      this.fastWindows = 0;
    }
  }

  private apply(tier: number): void {
    const t = this.tiers[tier];
    if (!t) return;
    this.tier = tier;
    this.cooldown = COOLDOWN_S;
    this.fastWindows = 0;
    this.frames.length = 0;
    this.renderer.setPixelRatio(t.ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== t.shadow) {
      shadow.mapSize.set(t.shadow, t.shadow);
      shadow.map?.dispose();
      shadow.map = null; // force reallocation at the new size
      // Re-render once even when the night path has shadowMap.autoUpdate off —
      // materials keep sampling the (now disposed) map otherwise.
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.onApply();
  }
}
