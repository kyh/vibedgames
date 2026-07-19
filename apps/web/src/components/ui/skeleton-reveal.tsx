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
 * Once the sweep completes, the masks and the skeleton drop from the DOM.
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
  const [retired, setRetired] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // -100 → content fully masked out (skeleton fully visible); 100 → content
  // fully revealed. The soft edge spans the whole frame, so this reads as a
  // directional fade rather than a hard wipe.
  const progress = useMotionValue(-100);
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
  }, [ready, progress, prefersReducedMotion]);

  if (!ready) return <div className={className}>{skeleton}</div>;
  if (retired) return <div className={className}>{children}</div>;

  return (
    <div className={cn("relative", className)}>
      <motion.div style={{ maskImage: contentMask, WebkitMaskImage: contentMask }}>
        {children}
      </motion.div>
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ maskImage: skeletonMask, WebkitMaskImage: skeletonMask }}
      >
        {skeleton}
      </motion.div>
    </div>
  );
};
