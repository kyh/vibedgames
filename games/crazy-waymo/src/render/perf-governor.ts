import type * as THREE from "three";

import { FrameTimingWindow } from "./frame-timing-window";

import { FULL_QUALITY, isCoarsePointer, type QualityFeatures, setLiveQuality } from "./quality";

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
// Decisions use sustained frame cost over ~2s windows. The sampler rejects
// isolated shader/GC stalls, while recurrent missed refreshes still count even
// when the median hits vsync. Downgrade on one bad window; upgrade only after
// several consecutive fast ones so the tier never flaps at a boundary.

const SLOW_MS = 21; // sustained worse than ~48fps → step down
// "Fast" must include a 60Hz vsync-locked frame (~16.7ms) — with a 13ms bar a
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

/** Resolution and scene detail can improve without a fourfold phone shadow
 * allocation or returning to the full sky shader. Desktop budgets stay intact. */
export function qualityTiers(native: number, mobile: boolean): readonly Tier[] {
  const ratios: readonly [number, number, number, number, number] = [
    native,
    Math.max(1, native * 0.8),
    Math.max(0.9, native * 0.66),
    Math.max(0.8, native * 0.55),
    Math.max(0.7, native * 0.45), // floor for weak GPUs
  ];
  if (!mobile) {
    return ratios.map((ratio, i) => ({
      ratio,
      shadow: i >= 3 ? SHADOW_LOW : SHADOW_FULL,
      ...FULL_QUALITY,
    }));
  }
  // Phones keep a stable shadow allocation and baked sky at every tier.
  // Higher tiers still earn resolution, cloud density, and the full-model band.
  return [
    { ratio: ratios[0], shadow: SHADOW_LOW, ...FULL_QUALITY, skyBake: true },
    {
      ratio: ratios[1],
      shadow: SHADOW_LOW,
      shadowEvery: 1,
      shadowCast: true,
      skyBake: true,
      clouds: 1,
      detailScale: 0.9,
    },
    {
      ratio: ratios[2],
      shadow: SHADOW_LOW,
      shadowEvery: 2,
      shadowCast: true,
      skyBake: true,
      clouds: 1,
      detailScale: 0.78,
    },
    {
      ratio: ratios[3],
      shadow: SHADOW_LOW,
      shadowEvery: 3,
      shadowCast: true,
      skyBake: true,
      clouds: 1,
      detailScale: 0.66,
    },
    {
      ratio: ratios[4],
      shadow: SHADOW_LOW,
      shadowEvery: 3,
      shadowCast: false, // floor: no shadow pass, no receiver sampling
      skyBake: true,
      clouds: 0,
      detailScale: 0.55,
    },
  ];
}

export class PerfGovernor {
  private readonly tiers: readonly Tier[];
  private tier = 0;
  private cooldown = 1.5; // grace at boot
  private readonly frames = new FrameTimingWindow();
  private fastWindows = 0;
  private upgradeCost = UPGRADE_WINDOWS;
  private sinceUpgrade = Infinity; // seconds since the last tier-up
  private shadowClock = 0; // frames since the last cadenced shadow render
  private pinned: number | null = null; // DEV: tier held by a measurement run

  constructor(
    private renderer: THREE.WebGLRenderer,
    private sun: THREE.DirectionalLight,
    private onApply: (features: QualityFeatures) => void,
  ) {
    const native = Math.min(window.devicePixelRatio || 1, 2);
    const mobile = isCoarsePointer();
    this.tiers = qualityTiers(native, mobile);
    if (mobile) {
      // Boot LOW: the timing windows need ~10s to converge, and a phone
      // chugging through those first windows at desktop quality reads as a
      // broken game. Dense screens start at the deeper tier; upgrades are
      // cheap if the device turns out to have headroom.
      this.apply(native >= 2 ? 3 : 2);
      this.cooldown = 1.5;
    }
    if (import.meta.env.DEV) installPerfDebug(this);
  }

  get currentTier(): number {
    return this.tier;
  }

  get tierCount(): number {
    return this.tiers.length;
  }

  get features(): QualityFeatures {
    return this.tiers[this.tier] ?? FULL_QUALITY;
  }

  /** A suspended scene has no useful performance history. Keep its tier, but
   * require fresh active windows after resume instead of promoting from idle. */
  resetTiming(): void {
    this.frames.reset();
    this.fastWindows = 0;
    this.cooldown = COOLDOWN_S;
  }

  // DEV/headless only: pin a tier so a measurement run can walk the whole
  // ladder. Without this the mobile tiers are unreachable from a scripted
  // browser — the timing windows own the tier and move it mid-capture,
  // and no perf claim about "tier 3 on a phone" could ever be verified.
  // `null` hands control back to the governor. See installPerfDebug below.
  pinTier(tier: number | null): void {
    this.pinned = tier;
    if (tier !== null) this.apply(Math.min(this.tiers.length - 1, Math.max(0, tier)));
  }

  // Feed the RAW frame delta (seconds) every frame, before render.
  update(dt: number): void {
    if (this.pinned !== null) return;
    if (document.hidden) {
      this.frames.reset();
      return;
    }
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.25);
    this.sinceUpgrade += dt;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    const frameMs = this.frames.sample(dt);
    if (frameMs === null) return;
    if (frameMs > SLOW_MS && this.tier < this.tiers.length - 1) {
      // Downgrading right after an upgrade means the upgrade was wrong —
      // make the next attempt exponentially more patient.
      if (this.sinceUpgrade < FLAP_WINDOW_S) {
        this.upgradeCost = Math.min(UPGRADE_WINDOWS_MAX, this.upgradeCost * 2);
      }
      this.apply(this.tier + 1);
    } else if (frameMs < FAST_MS && this.tier > 0) {
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
    this.frames.reset();
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
    // Publish BEFORE the scene hook: the city streamer reads the live tier on
    // its next updateStreaming, which can happen inside onApply's frame.
    setLiveQuality(t);
    this.onApply(t);
  }
}

// DEV-only handle, same gate and same spirit as main.ts's `__renderer` /
// `__waymo`: a headless perf run needs to WALK the tier ladder, and the tier
// lives in a private field of an instance main.ts never publishes. Stripped
// from production builds by the `import.meta.env.DEV` branch at the call site.
declare global {
  interface Window {
    __perf?: {
      tier(): number;
      tierCount(): number;
      pin(tier: number | null): void;
      detail(scale: number): void;
    };
  }
}

function installPerfDebug(governor: PerfGovernor): void {
  window.__perf = {
    tier: () => governor.currentTier,
    tierCount: () => governor.tierCount,
    pin: (tier) => governor.pinTier(tier),
    // Override the tier's model band live. A/B-ing a draw-distance change by
    // reloading is worthless on a shared machine — the other tab's load moves
    // the frame rate more than the change does; this measures both sides
    // back-to-back in one session.
    detail: (detailScale) => setLiveQuality({ ...governor.features, detailScale }),
  };
}
