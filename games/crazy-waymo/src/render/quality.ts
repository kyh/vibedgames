import { DRAW_DISTANCE } from "../shared/constants";
import { contextLostBefore } from "./safe-mode";

export const isCoarsePointer = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export const PHONE_REACH = 0.72;
export const SAFE_REACH = 0.55;

export const reachScale = () => {
  if (contextLostBefore()) {
    return SAFE_REACH;
  }

  return isCoarsePointer() ? PHONE_REACH : 1;
};

export const drawDistance = () => Math.round(DRAW_DISTANCE * reachScale());

export const PHONE_TOP_TIER = 2;

export type CloudQuality = 0 | 1 | 2;

export interface QualityFeatures {
  readonly shadowEvery: number;
  readonly shadowCast: boolean;
  readonly skyBake: boolean;
  readonly clouds: CloudQuality;
  readonly detailScale: number;
}

export const FULL_QUALITY: QualityFeatures = {
  clouds: 2,
  detailScale: 1,
  shadowCast: true,
  shadowEvery: 1,
  skyBake: false,
};

let live: QualityFeatures = FULL_QUALITY;

export const setLiveQuality = (q: QualityFeatures) => {
  live = q;
};

export const liveQuality = () => live;
