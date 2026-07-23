import { useAnimate, useReducedMotion } from "motion/react";

import { SHAKE_KEYFRAMES, SHAKE_TRANSITION } from "@repo/ui/lib/motion";

/**
 * Horizontal error shake. Attach the returned `scope` to the element to nudge,
 * then call `shake()` on failure (e.g. a rejected submit). Honors
 * reduced-motion. Replay is native — call it again to re-run.
 *
 *   const [scope, shake] = useShake();
 *   <form ref={scope} ...>
 *   onError: () => shake()
 */
export const useShake = () => {
  const [scope, animate] = useAnimate();
  const reduceMotion = useReducedMotion();
  const shake = () => {
    if (reduceMotion || !scope.current) return;
    animate(scope.current, SHAKE_KEYFRAMES, SHAKE_TRANSITION);
  };
  return [scope, shake] as const;
};
