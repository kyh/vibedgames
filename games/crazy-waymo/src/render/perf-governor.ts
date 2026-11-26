import type * as THREE from "three";

import { FrameTimingWindow } from "./frame-timing-window";

import { FULL_QUALITY, PHONE_TOP_TIER, isCoarsePointer, setLiveQuality } from "./quality";
import type { QualityFeatures } from "./quality";
import { safeMode } from "./safe-mode";

const SLOW_MS = 21;
const FAST_MS = 17;
const UPGRADE_WINDOWS = 3;
const UPGRADE_WINDOWS_MAX = 24;
const FLAP_WINDOW_S = 12;
const COOLDOWN_S = 2.5;
const SHADOW_FULL = 2048;
const SHADOW_LOW = 1024;

type Tier = QualityFeatures & { readonly ratio: number; readonly shadow: number };

/** Resolution and scene detail can improve without a fourfold phone shadow
 * allocation or returning to the full sky shader. Desktop budgets stay intact. */
export const qualityTiers: (native: number, mobile: boolean) => readonly Tier[] = (
  native,
  mobile,
) => {
  const ratios: readonly [number, number, number, number, number] = [
    native,
    Math.max(1, native * 0.8),
    Math.max(0.9, native * 0.66),
    Math.max(0.8, native * 0.55),
    Math.max(0.7, native * 0.45),
  ];

  if (!mobile) {
    return ratios.map((ratio, i) => ({
      ratio,
      shadow: i >= 3 ? SHADOW_LOW : SHADOW_FULL,
      ...FULL_QUALITY,
    }));
  }

  return [
    { ratio: ratios[0], shadow: SHADOW_LOW, ...FULL_QUALITY, skyBake: true },
    {
      clouds: 1,
      detailScale: 0.9,
      ratio: ratios[1],
      shadow: SHADOW_LOW,
      shadowCast: true,
      shadowEvery: 1,
      skyBake: true,
    },
    {
      clouds: 1,
      detailScale: 0.78,
      ratio: ratios[2],
      shadow: SHADOW_LOW,
      shadowCast: true,
      shadowEvery: 2,
      skyBake: true,
    },
    {
      clouds: 1,
      detailScale: 0.66,
      ratio: ratios[3],
      shadow: SHADOW_LOW,
      shadowCast: true,
      shadowEvery: 3,
      skyBake: true,
    },
    {
      clouds: 0,
      detailScale: 0.55,
      ratio: ratios[4],
      shadow: SHADOW_LOW,
      shadowCast: false,
      shadowEvery: 3,
      skyBake: true,
    },
  ];
};

declare global {
  interface Window {
    __perf?: {
      tier: () => number;
      tierCount: () => number;
      pin: (tier: number | null) => void;
      detail: (scale: number) => void;
    };
  }
}

const installPerfDebug = (governor: PerfGovernor) => {
  window.__perf = {
    detail: (detailScale) => {
      setLiveQuality({ ...governor.features, detailScale });
    },
    pin: (tier) => {
      governor.pinTier(tier);
    },
    tier: () => governor.currentTier,
    tierCount: () => governor.tierCount,
  };
};

export class PerfGovernor {
  private readonly tiers: readonly Tier[];
  private readonly topTier: number;
  private tier = 0;
  private cooldown = 1.5;
  private readonly frames = new FrameTimingWindow();
  private fastWindows = 0;
  private upgradeCost = UPGRADE_WINDOWS;
  private sinceUpgrade = Infinity;
  private shadowClock = 0;
  private pinned: number | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly sun: THREE.DirectionalLight;
  private readonly onApply: (features: QualityFeatures) => void;

  constructor(
    renderer: THREE.WebGLRenderer,
    sun: THREE.DirectionalLight,
    onApply: (features: QualityFeatures) => void,
  ) {
    this.renderer = renderer;
    this.sun = sun;
    this.onApply = onApply;
    const native = Math.min(window.devicePixelRatio || 1, 2);
    const mobile = isCoarsePointer();
    this.tiers = qualityTiers(native, mobile);
    const floor = this.tiers.length - 1;

    if (safeMode()) {
      this.topTier = floor;
      this.apply(floor);
      this.cooldown = 1.5;
    } else {
      this.topTier = mobile ? PHONE_TOP_TIER : 0;
    }

    if (mobile && !safeMode()) {
      this.apply(native >= 2 ? 3 : 2);
      this.cooldown = 1.5;
    }

    if (import.meta.env.DEV) {
      installPerfDebug(this);
    }
  }

  get currentTier() {
    return this.tier;
  }

  get tierCount() {
    return this.tiers.length;
  }

  get features() {
    return this.tiers[this.tier] ?? FULL_QUALITY;
  }

  /** A suspended scene has no useful performance history. Keep its tier, but
   * require fresh active windows after resume instead of promoting from idle. */
  resetTiming() {
    this.frames.reset();
    this.fastWindows = 0;
    this.cooldown = COOLDOWN_S;
  }

  pinTier(tier: number | null) {
    this.pinned = tier;

    if (tier !== null) {
      this.apply(Math.min(this.tiers.length - 1, Math.max(0, tier)));
    }
  }

  update(dt: number) {
    if (this.pinned !== null) {
      return;
    }

    if (document.hidden) {
      this.frames.reset();

      return;
    }

    if (!Number.isFinite(dt) || dt <= 0) {
      return;
    }

    const step = Math.min(dt, 0.25);
    this.sinceUpgrade += step;

    if (this.cooldown > 0) {
      this.cooldown -= step;

      return;
    }

    const frameMs = this.frames.sample(step);

    if (frameMs === null) {
      return;
    }

    if (frameMs > SLOW_MS && this.tier < this.tiers.length - 1) {
      if (this.sinceUpgrade < FLAP_WINDOW_S) {
        this.upgradeCost = Math.min(UPGRADE_WINDOWS_MAX, this.upgradeCost * 2);
      }

      this.apply(this.tier + 1);
    } else if (frameMs < FAST_MS && this.tier > this.topTier) {
      this.fastWindows += 1;

      if (this.fastWindows >= this.upgradeCost) {
        this.sinceUpgrade = 0;
        this.apply(this.tier - 1);
      }
    } else {
      this.fastWindows = 0;
    }
  }

  syncShadow(shadowsActive: boolean) {
    const t = this.tiers[this.tier];

    if (!t || t.shadowEvery <= 1 || !t.shadowCast) {
      return;
    }

    const sm = this.renderer.shadowMap;
    sm.autoUpdate = false;

    if (!this.sun.shadow.map) {
      sm.needsUpdate = true;

      return;
    }

    if (!shadowsActive) {
      return;
    }

    this.shadowClock += 1;

    if (this.shadowClock >= t.shadowEvery) {
      this.shadowClock = 0;
      sm.needsUpdate = true;
    }
  }

  private apply(tier: number) {
    const t = this.tiers[tier];

    if (!t) {
      return;
    }

    this.tier = tier;
    this.cooldown = COOLDOWN_S;
    this.fastWindows = 0;
    this.frames.reset();
    this.renderer.setPixelRatio(t.ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const { shadow } = this.sun;

    if (shadow.mapSize.x !== t.shadow) {
      shadow.mapSize.set(t.shadow, t.shadow);
      shadow.map?.dispose();
      shadow.map = null;
      this.renderer.shadowMap.needsUpdate = true;
    }

    setLiveQuality(t);
    this.onApply(t);
  }
}
