// Low-graphics mode a device earns by losing its WebGL context. Chrome kills
// the GPU process when a page's resident set or a frame's work exceeds what
// the phone will carry, and after two kills it blocks WebGL for the domain for
// the rest of the session — so the device that failed once must boot smaller
// the next time without being asked. The flag lives in localStorage; `?safe=1`
// forces it for a visit, `?safe=0` clears it.
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
let fragileGpu = false;

/** A driver known to die under the shadow pass boots on the floor tier
 *  without having to crash first; `?safe=0` still overrides for a visit. */
export const markFragileGpu = (fragile: boolean): void => {
  fragileGpu = fragile;
};

export const safeMode = (): boolean => {
  if (cached !== null) {
    return cached;
  }
  const p = param();
  if (p === "0") {
    clearSafeMode();
    cached = false;
  } else {
    cached = p === "1" || stored() || fragileGpu;
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
