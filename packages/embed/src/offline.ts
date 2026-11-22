import { isPlayables } from "./playables";

/**
 * True when this page was booted with `?offline` / `?offline=1`, or runs
 * inside YouTube Playables, which refuses every request to another host.
 */
export const isOfflineRequested = () => {
  if (isPlayables()) {
    return true;
  }

  if (!("location" in globalThis)) {
    return false;
  }

  const value = new URLSearchParams(location.search).get("offline");

  // WARNING: a bare ?offline must never dial production; only an explicit 0 opts back in.
  return value !== null && value !== "0";
};
