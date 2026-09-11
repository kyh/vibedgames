// Low-graphics mode: every phone, and any device that has lost its WebGL
// context. Chrome kills the GPU process when a page's resident set or a
// frame's work exceeds what the device will carry, and phone drivers have
// died under three's shadow pass alone — so a phone boots small without
// being asked, and a desktop that failed once boots small the next time. The
// loss flag lives in localStorage; `?safe=1` forces the mode for a visit,
// `?safe=0` clears it.
const KEY = "crazy-waymo:gpu-lost";

const param = (): string | null => {
  try {
    return new URLSearchParams(window.location.search).get("safe");
  } catch {
    return null;
  }
};

const stored = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
};

export const clearSafeMode = (): void => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
};

let cached: boolean | null = null;

const coarsePointer = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export const safeMode = (): boolean => {
  if (cached !== null) {
    return cached;
  }
  const p = param();
  if (p === "0") {
    clearSafeMode();
    cached = false;
  } else {
    cached = p === "1" || stored() || coarsePointer();
  }
  return cached;
};

/** Called from the context-lost handler: the next boot runs small. */
export const recordContextLoss = (): void => {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // no persistence: the reload boots at the normal tier and may fail again
  }
};
