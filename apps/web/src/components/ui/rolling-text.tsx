import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@repo/ui/lib/utils";

type RollingTextProps = {
  /** Words to cycle through. The first word is used as the stable accessible label. */
  words: string[];
  /** How long each word stays on screen, in ms. */
  interval?: number;
  /** Per-character stagger of the roll, in seconds. */
  stagger?: number;
  /** Duration of a single character's roll, in seconds. */
  duration?: number;
  className?: string;
};

/**
 * Cycles through `words`, rolling each one in/out per-character on the X axis —
 * the motion-primitives "text-roll" look applied to a rotating word.
 */
export const RollingText = ({
  words,
  interval = 2200,
  stagger = 0.03,
  duration = 0.5,
  className,
}: RollingTextProps) => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (words.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), interval);
    return () => clearInterval(id);
  }, [words.length, interval]);

  const word = words[index] ?? "";

  return (
    <span
      className={cn("relative inline-flex [perspective:600px]", className)}
      // Keep the spoken/indexed text stable while the glyphs animate.
      aria-label={words[0]}
    >
      <AnimatePresence mode="wait" initial={false}>
        <span key={word} aria-hidden className="inline-flex">
          {word.split("").map((char, i) => (
            <motion.span
              key={`${word}-${i}`}
              className="inline-block [backface-visibility:hidden] [transform-origin:50%_100%]"
              initial={{ rotateX: -90, opacity: 0 }}
              animate={{ rotateX: 0, opacity: 1 }}
              exit={{ rotateX: 90, opacity: 0 }}
              transition={{
                duration,
                delay: i * stagger,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {char}
            </motion.span>
          ))}
        </span>
      </AnimatePresence>
    </span>
  );
};
