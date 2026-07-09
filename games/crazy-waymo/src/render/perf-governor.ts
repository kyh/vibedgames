import type * as THREE from "three";

import { FULL_QUALITY, isCoarsePointer, type QualityFeatures } from "./quality";

// Adaptive quality: keeps the game at target frame rate by stepping render
// resolution (and, at the floor tier, shadow resolution) instead of letting it
// chug. Fill rate is the dominant cost on high-DPR screens — dropping the
// pixel ratio a notch recovers far more than any scene tweak.
//
// On top of the resolution steps, MOBILE tiers bundle feature cuts (shadow
// sampling quality/cadence, baked sky, cloud density) — see quality.ts. The
// desktop table pins every tier to FULL_QUALITY so a desktop that steps down
// only ever loses resolution, exactly as before.
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

type Tier = QualityFeatures & { readonly ratio: number; readonly shadow: number };

export class PerfGovernor {
  private readonly tiers: readonly Tier[];
  private tier = 0;
  private cooldown = 1.5; // grace at boot
  private frames: number[] = [];
  private fastWindows = 0;
  private upgradeCost = UPGRADE_WINDOWS;
  private sinceUpgrade = Infinity; // seconds since the last tier-up
  private shadowClock = 0; // frames since the last cadenced shadow render

  constructor(
    private renderer: THREE.WebGLRenderer,
    private sun: THREE.DirectionalLight,
    private onApply: (features: QualityFeatures) => void,
  ) {
    const native = Math.min(window.devicePixelRatio || 1, 2);
    const ratios = [
      native,
      Math.max(1, native * 0.8),
      Math.max(0.9, native * 0.66),
      Math.max(0.8, native * 0.55),
      Math.max(0.7, native * 0.45), // floor for weak GPUs
    ] as const;
    if (isCoarsePointer()) {
      // Phone ladder: tier 0 is still the full desktop look (an iPad Pro can
      // earn it), everything below trades per-fragment work for frame rate.
      this.tiers = [
        { ratio: ratios[0], shadow: SHADOW_FULL, ...FULL_QUALITY },
        {
          ratio: ratios[1],
          shadow: SHADOW_FULL,
          shadowEvery: 1,
          shadowCast: true,
          skyBake: true,
          clouds: 1,
        },
        {
          ratio: ratios[2],
          shadow: SHADOW_FULL,
          shadowEvery: 2,
          shadowCast: true,
          skyBake: true,
          clouds: 1,
        },
        {
          ratio: ratios[3],
          shadow: SHADOW_LOW,
          shadowEvery: 3,
          shadowCast: true,
          skyBake: true,
          clouds: 1,
        },
        {
          ratio: ratios[4],
          shadow: SHADOW_LOW,
          shadowEvery: 3,
          shadowCast: false, // floor: no shadow pass, no receiver sampling
          skyBake: true,
          clouds: 0,
        },
      ];
      // Boot LOW: the median-window logic needs ~10s to converge, and a phone
      // chugging through those first windows at desktop quality reads as a
      // broken game. Dense screens start at the deeper tier; upgrades are
      // cheap if the device turns out to have headroom.
      this.apply(native >= 2 ? 3 : 2);
      this.cooldown = 1.5;
    } else {
      // Desktop: resolution/shadow-size steps only — features stay at full on
      // every tier, so nothing about the desktop look changes at any tier.
      this.tiers = ratios.map((ratio, i) =>
        Object.assign({ ratio, shadow: i >= 3 ? SHADOW_LOW : SHADOW_FULL }, FULL_QUALITY),
      );
    }
  }

  get currentTier(): number {
    return this.tier;
  }

  get features(): QualityFeatures {
    return this.tiers[this.tier] ?? FULL_QUALITY;
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

  // Cadenced shadow pass (mobile low tiers): render the depth map every Nth
  // frame instead of every frame. Called once per frame AFTER the scene
  // update (which may move the shadow target) and BEFORE render.
  // `shadowsActive` is the day-night ramp — at night the pass stays parked
  // exactly like the every-frame path. Re-asserts autoUpdate=false each frame
  // because the day-night dawn flip sets it back to true.
  syncShadow(shadowsActive: boolean): void {
    const t = this.tiers[this.tier];
    if (!t || t.shadowEvery <= 1 || !t.shadowCast) return;
    const sm = this.renderer.shadowMap;
    sm.autoUpdate = false;
    // No depth map yet (night boots): keep rendering the pass until one
    // exists, or receiver programs sample a texture that never materializes
    // (GL_INVALID_OPERATION — see day-night.ts).
    if (!this.sun.shadow.map) {
      sm.needsUpdate = true;
      return;
    }
    if (!shadowsActive) return;
    this.shadowClock++;
    if (this.shadowClock >= t.shadowEvery) {
      this.shadowClock = 0;
      sm.needsUpdate = true;
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
    this.onApply(t);
  }
}
