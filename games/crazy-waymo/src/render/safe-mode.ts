const KEY = "crazy-waymo:gpu-lost";

const param = () => {
  try {
    return new URLSearchParams(window.location.search).get("safe");
  } catch {
    return null;
  }
};

const stored = () => {
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
};

export const clearSafeMode = () => {
  try {
    window.localStorage.removeItem(KEY);

    return true;
  } catch {
    return false;
  }
};

let cached: boolean | null = null;

const coarsePointer = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** The device lost a context before (or `?safe=1` says to act as if): the
 *  world shrinks further than a phone's default reach. */
export const contextLostBefore = () => {
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

export const safeMode = () => contextLostBefore() || (coarsePointer() && param() !== "0");

/** Called from the context-lost handler: the next boot runs small. */
export const recordContextLoss = () => {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));

    return true;
  } catch {
    return false;
  }
};
