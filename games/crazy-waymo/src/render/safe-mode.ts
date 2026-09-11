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

const requested = (): boolean => {
  if (cached !== null) {
    return cached;
  }
  const p = param();
  if (p === "0") {
    clearSafeMode();
    cached = false;
  } else {
    cached = p === "1" || stored();
  }
  return cached;
};

/** A driver known to die under the shadow pass boots on the floor tier
 *  without having to crash first. Not folded into the cache: module-level
 *  callers run before the renderer exists to be asked about its GPU. */
export const markFragileGpu = (fragile: boolean): void => {
  fragileGpu = fragile;
};

/** `?safe=0` still overrides, so a fragile device can be retried on purpose. */
export const isFragileGpu = (): boolean => fragileGpu && param() !== "0";

export const safeMode = (): boolean => requested() || isFragileGpu();

/** Called from the context-lost handler: the next boot runs small. */
export const recordContextLoss = (): void => {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // no persistence: the reload boots at the normal tier and may fail again
  }
};
