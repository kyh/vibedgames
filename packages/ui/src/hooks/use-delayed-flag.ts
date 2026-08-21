import { useEffect, useState } from "react";

/**
 * True only once `active` has been continuously true for `ms`.
 *
 * The honest way to drive a progress indicator. Wired straight to "is it in
 * flight", a spinner flashes on and off for a request that resolves in tens of
 * milliseconds — motion and layout change for something the user never had
 * time to read as waiting. Gate it behind a delay and a fast response never
 * shows one at all, while a slow one gets real feedback.
 *
 *   const showSpinner = useDelayedFlag(mutation.isPending, 200);
 *
 * Prefer this over holding an indicator up for a minimum duration: a floor
 * outlives the request, so the spinner is still turning after the result has
 * landed and the UI has moved on.
 */
export const useDelayedFlag = (active: boolean, ms: number) => {
  const [elapsed, setElapsed] = useState(false);
  const [armedFor, setArmedFor] = useState(active);

  if (armedFor !== active) {
    setArmedFor(active);
    setElapsed(false);
  }

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => setElapsed(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);

  return active && elapsed;
};
