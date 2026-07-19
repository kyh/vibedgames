import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";

import { cn } from "@repo/ui/lib/utils";

const WIPE_DURATION = 0.6;

/**
 * Angled crossfade from skeleton to content. While loading, the skeleton
 * renders alone. When `ready` flips, the content fades in behind a tilted
 * gradient mask sweeping across the frame while an exactly inverse mask
 * fades the skeleton out at the same moving edge — at every point the two
 * opacities sum to one, so there's no cover slab and no double exposure.
 *
 * The skeleton and content each keep ONE tree position across every phase —
 * only styles change — so nothing remounts mid-reveal (remounts replay CSS
 * entrance animations and refetch images, which reads as flashing). Masks
 * are removed once the sweep retires so they can't linger as a backdrop
 * root and break descendant backdrop-filter. Mounting with `ready` already
 * true (cached data, revisits) skips the animation entirely.
 */
export const SkeletonReveal = ({
  ready,
  skeleton,
  children,
  className,
}: {
  ready: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => {
  const [retired, setRetired] = useState(ready);
  const prefersReducedMotion = useReducedMotion();

  // -100 → content fully masked out (skeleton fully visible); 100 → content
  // fully revealed. The soft edge spans the whole frame, so this reads as a
  // directional fade rather than a hard wipe.
  const progress = useMotionValue(retired ? 100 : -100);
  const contentMask = useTransform(
    progress,
    (value) => `linear-gradient(105deg, black ${value}%, transparent ${value + 100}%)`,
  );
  const skeletonMask = useTransform(
    progress,
    (value) => `linear-gradient(105deg, transparent ${value}%, black ${value + 100}%)`,
  );

  useEffect(() => {
    if (!ready) {
      progress.set(-100);
      setRetired(false);
      return;
    }
    if (retired) return;
    // Reduced motion still needs the skeleton to get out of the way — it
    // just shouldn't travel to do it.
    if (prefersReducedMotion) {
      setRetired(true);
      return;
    }
    const controls = animate(progress, 100, {
      duration: WIPE_DURATION,
      ease: "easeInOut",
      onComplete: () => setRetired(true),
    });
    return () => controls.stop();
  }, [ready, retired, progress, prefersReducedMotion]);

  return (
    <div className={cn("relative", className)}>
      <motion.div
        style={retired ? undefined : { maskImage: contentMask, WebkitMaskImage: contentMask }}
      >
        {ready ? children : null}
      </motion.div>
      {!retired && (
        <motion.div
          aria-hidden
          className={ready ? "pointer-events-none absolute inset-0 overflow-hidden" : undefined}
          style={ready ? { maskImage: skeletonMask, WebkitMaskImage: skeletonMask } : undefined}
        >
          {skeleton}
        </motion.div>
      )}
    </div>
  );
};
