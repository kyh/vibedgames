import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, type TargetAndTransition } from "motion/react";
import { cn } from "@repo/ui/lib/utils";

const NBSP = " ";
const glyph = (char: string) => (char === " " ? NBSP : char);

// Springy overshoot — slot-text's "back" easing, so each letter lands with a
// little bounce instead of stopping flat.
const EASE = [0.34, 1.56, 0.64, 1] as const;

// Deterministic [-1, 1] jitter per character. Scaled by `bounce` it gives every
// glyph its own tilt so the line doesn't land as one rigid block.
const wobble = (i: number, salt: number) => {
  const n = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
};

type ChromaticOptions = {
  from?: number;
  spread?: number;
  saturation?: number;
  lightness?: number;
};

/**
 * Hue sweep across the line: every glyph rolls in its own color, so the change
 * lands as a chromatic spectrum before settling to the resting color.
 *
 *   <RollingText color={chromatic()} />            // full rainbow
 *   <RollingText color={chromatic({ from: 190 })} /> // start cyan
 */
export const chromatic =
  ({ from = 0, spread = 320, saturation = 92, lightness = 60 }: ChromaticOptions = {}) =>
  (index: number, total: number) => {
    const t = total <= 1 ? 0 : index / (total - 1);
    return `hsl(${(from + t * spread) % 360} ${saturation}% ${lightness}%)`;
  };

type RollingTextProps = {
  /** Words to cycle through. The first is the stable accessible label. */
  words: string[];
  /** How long each word stays on screen, in ms. */
  interval?: number;
  /** "down": new glyph enters from the top; "up": from the bottom. */
  direction?: "up" | "down";
  /** Per-character stagger, in seconds. */
  stagger?: number;
  /** Roll duration per character, in seconds. */
  duration?: number;
  /** How long the incoming glyph trails the outgoing one, in seconds. */
  exitOffset?: number;
  /** 0 = every glyph lands identically; 1 = lots of per-letter tilt variation. */
  bounce?: number;
  /** Chromatic flash: (index, total) => CSS color. Omit for none. */
  color?: (index: number, total: number) => string;
  /** How long the chromatic tint fades back to rest, in seconds. */
  colorFade?: number;
  className?: string;
};

/**
 * Cycles through `words`, rolling each one in/out per-character in a clipped
 * slot — the slot-text vertical roll, rebuilt on motion. Each glyph slides in
 * as the previous one slides out (chasing it by `exitOffset`), with an optional
 * chromatic tint that fades to the resting color once it lands.
 */
export const RollingText = ({
  words,
  interval = 2200,
  direction = "down",
  stagger = 0.045,
  duration = 0.3,
  exitOffset = 0.05,
  bounce = 0.6,
  color,
  colorFade = 0.28,
  className,
}: RollingTextProps) => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (words.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), interval);
    return () => clearInterval(id);
  }, [words.length, interval]);

  // Pad to the longest word so trailing cells roll out instead of popping.
  const len = useMemo(() => words.reduce((max, word) => Math.max(max, word.length), 0), [words]);
  const word = words[index] ?? "";
  const enterY = direction === "down" ? "-100%" : "100%";
  const exitY = direction === "down" ? "100%" : "-100%";

  return (
    <span className={cn("inline-flex", className)} aria-label={words[0]}>
      {Array.from({ length: len }, (_, i) => {
        const char = word[i] ?? "";
        const tilt = bounce * 5 * wobble(i, 3);
        const base = i * stagger;
        const tint = color?.(i, len);

        // The new glyph rolls in tinted (--flash: 1) and the tint mixes out to
        // the resting color via color-mix, so it works regardless of the theme's
        // color space (currentColor is oklch here).
        const enter: TargetAndTransition = {
          y: "0%",
          rotate: 0,
          transition: {
            y: { delay: base + exitOffset, duration, ease: EASE },
            rotate: { delay: base + exitOffset, duration, ease: EASE },
          },
        };
        const initial: TargetAndTransition = { y: enterY, rotate: tilt };
        if (tint) {
          initial["--flash"] = 1;
          enter["--flash"] = 0;
          (enter.transition as Record<string, unknown>)["--flash"] = {
            delay: base + exitOffset + duration,
            duration: colorFade,
            ease: "linear",
          };
        }

        return (
          <span
            key={i}
            aria-hidden
            className="relative inline-flex justify-center overflow-x-visible [overflow-y:clip]"
          >
            {/* Invisible sizer keeps the cell glyph-sized so the absolutely
                positioned faces never reflow the line as they roll. */}
            <span className="invisible">{glyph(char) || NBSP}</span>
            <AnimatePresence initial={false}>
              <motion.span
                key={index}
                className="absolute inset-0 flex items-center justify-center will-change-transform"
                style={
                  tint
                    ? {
                        color: `color-mix(in oklab, ${tint} calc(var(--flash) * 100%), currentColor)`,
                      }
                    : undefined
                }
                initial={initial}
                animate={enter}
                exit={{
                  y: exitY,
                  rotate: -tilt,
                  transition: {
                    y: { delay: base, duration, ease: EASE },
                    rotate: { delay: base, duration, ease: EASE },
                  },
                }}
              >
                {glyph(char)}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
};
