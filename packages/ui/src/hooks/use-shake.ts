import { useAnimate, useReducedMotion } from "motion/react";

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
    animate(
      scope.current,
      { x: [0, 6, -6, 4, 0] },
      { duration: 0.28, times: [0, 0.2857, 0.5714, 0.7857, 1], ease: [0.22, 1, 0.36, 1] },
    );
  };
  return [scope, shake] as const;
};
