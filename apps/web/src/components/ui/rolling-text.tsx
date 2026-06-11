import { useEffect, useMemo, useRef, useState } from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  type TargetAndTransition,
} from "motion/react";
import { cn } from "@repo/ui/lib/utils";

const NBSP = "\u00A0";
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

// Width of the glyph `char` puts in a column, read off that column's hidden
// candidate spans. 0 when the current word doesn't reach this column.
const measureChar = (els: Map<string, HTMLSpanElement>, char: string) => {
  if (!char) return 0;
  const el = els.get(glyph(char));
  return el ? el.getBoundingClientRect().width : null;
};

type ChromaticOptions = {
  from?: number;
  spread?: number;
  saturation?: number;
  lightness?: number;
  /** Explicit color stops swept across the line instead of a hue ramp. */
  palette?: string[];
};

/**
 * Color sweep across the line: every glyph rolls in its own color, so the
 * change lands as a chromatic spectrum before settling to the resting color.
 *
 *   <RollingText color={chromatic()} />              // full rainbow
 *   <RollingText color={chromatic({ from: 190 })} /> // start cyan
 *   <RollingText color={chromatic({ palette: ["#f00", "#00f"] })} />
 */
export const chromatic =
  ({ from = 0, spread = 320, saturation = 92, lightness = 60, palette }: ChromaticOptions = {}) =>
  (index: number, total: number) => {
    const t = total <= 1 ? 0 : index / (total - 1);
    if (palette && palette.length > 0) {
      if (palette.length === 1) return palette[0] ?? "";
      // Interpolate between the two stops this glyph falls between.
      const pos = t * (palette.length - 1);
      const lower = Math.min(Math.floor(pos), palette.length - 2);
      const mix = Math.round((pos - lower) * 100);
      const a = palette[lower] ?? "";
      const b = palette[lower + 1] ?? "";
      if (mix <= 0) return a;
      if (mix >= 100) return b;
      return `color-mix(in oklab, ${b} ${mix}%, ${a})`;
    }
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

type RollingColumnProps = {
  /** Every glyph this column can show, across all words. */
  candidates: string[];
  /** The glyph the current word puts in this column ("" when it's shorter). */
  char: string;
  /** Current word index — keys the faces so AnimatePresence swaps them. */
  wordKey: number;
  enterY: string;
  exitY: string;
  tilt: number;
  delay: number;
  exitOffset: number;
  duration: number;
  tint?: string;
  colorFade: number;
};

const RollingColumn = ({
  candidates,
  char,
  wordKey,
  enterY,
  exitY,
  tilt,
  delay,
  exitOffset,
  duration,
  tint,
  colorFade,
}: RollingColumnProps) => {
  const sizerRef = useRef<HTMLSpanElement>(null);
  const candidateEls = useRef(new Map<string, HTMLSpanElement>());
  const charRef = useRef(char);
  charRef.current = char;
  // "auto" until the first measurement, so SSR/pre-hydration falls back to the
  // widest-candidate width the sizer provides.
  const width = useMotionValue<number | "auto">("auto");

  // Size the column to the glyph it's currently showing — measured off the
  // hidden candidates — instead of the widest candidate, so narrow letters
  // like "l" don't float in a slot sized for "o" or "u". The width rolls to
  // the incoming glyph's in step with the letters.
  useEffect(() => {
    const target = measureChar(candidateEls.current, char);
    if (target === null) return;
    if (width.get() === "auto") {
      width.set(target);
      return;
    }
    const controls = animate(width, target, {
      delay: delay + exitOffset,
      duration,
      ease: "easeOut",
    });
    return () => controls.stop();
  }, [char, width, delay, exitOffset, duration]);

  // Re-measure when the sizer's own box changes (font load, breakpoint font
  // size) — jump straight to the new width, no roll.
  useEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const target = measureChar(candidateEls.current, charRef.current);
      if (target !== null) width.set(target);
    });
    observer.observe(sizer);
    return () => observer.disconnect();
  }, [width]);

  // The new glyph rolls in tinted (--flash: 1) and the tint mixes out to the
  // resting color via color-mix, so it works regardless of the theme's color
  // space (currentColor is oklch here).
  const roll = { delay: delay + exitOffset, duration, ease: EASE };
  const exitRoll = { delay, duration, ease: EASE };
  const initial: TargetAndTransition = {
    y: enterY,
    rotate: tilt,
    ...(tint && { "--flash": 1 }),
  };
  const enter: TargetAndTransition = {
    y: "0%",
    rotate: 0,
    ...(tint && { "--flash": 0 }),
    transition: {
      y: roll,
      rotate: roll,
      ...(tint && {
        "--flash": {
          delay: delay + exitOffset + duration,
          duration: colorFade,
          ease: "linear",
        },
      }),
    },
  };

  return (
    <motion.span
      aria-hidden
      style={{ width }}
      // overflow-y clips at the padding box, so the symmetric py/-my pair
      // extends the clip past tight line-heights (descenders like "g" were
      // getting cut) without changing the line metrics.
      className="relative -my-[0.2em] inline-flex min-w-0 justify-center overflow-x-visible py-[0.2em] [overflow-y:clip]"
    >
      {/* Invisible sizer renders every glyph this column can show (overlapped
          in one grid cell) so the current one can be measured. It also keeps
          the column at full text height while the faces are absolutely
          positioned. Until the first measurement lands, it sizes the column
          to its widest candidate. */}
      <span ref={sizerRef} className="invisible inline-grid">
        {(candidates.length ? candidates : [NBSP]).map((candidate) => (
          <span
            key={candidate}
            ref={(el) => {
              if (el) candidateEls.current.set(candidate, el);
              else candidateEls.current.delete(candidate);
            }}
            // justifySelf keeps each candidate at its own glyph width instead
            // of stretching to the cell, so the measurement is per-glyph.
            style={{ gridArea: "1 / 1", justifySelf: "start" }}
          >
            {candidate}
          </span>
        ))}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={wordKey}
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
            transition: { y: exitRoll, rotate: exitRoll },
          }}
        >
          {glyph(char)}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
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
  // Respect prefers-reduced-motion: no cycling, no roll — just the first word.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion || words.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), interval);
    return () => clearInterval(id);
  }, [reduceMotion, words.length, interval]);

  // Every glyph that can appear in each column, across all words (padded to
  // the longest word). The column renders them all in a hidden sizer so it can
  // measure whichever one the current word shows.
  const columns = useMemo(() => {
    const len = words.reduce((max, word) => Math.max(max, word.length), 0);
    return Array.from({ length: len }, (_, i) =>
      [...new Set(words.map((word) => word[i]).filter(Boolean) as string[])].map(glyph),
    );
  }, [words]);
  const len = columns.length;
  const word = words[index] ?? "";
  const enterY = direction === "down" ? "-100%" : "100%";
  const exitY = direction === "down" ? "100%" : "-100%";

  if (reduceMotion) {
    return <span className={cn("inline-flex", className)}>{words[0]}</span>;
  }

  return (
    <span className={cn("inline-flex", className)} aria-label={words[0]}>
      {Array.from({ length: len }, (_, i) => (
        <RollingColumn
          key={i}
          candidates={columns[i] ?? []}
          char={word[i] ?? ""}
          wordKey={index}
          enterY={enterY}
          exitY={exitY}
          tilt={bounce * 5 * wobble(i, 3)}
          delay={i * stagger}
          exitOffset={exitOffset}
          duration={duration}
          tint={color?.(i, len)}
          colorFade={colorFade}
        />
      ))}
    </span>
  );
};
