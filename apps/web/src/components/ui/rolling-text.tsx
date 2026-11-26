import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { MotionValue, TargetAndTransition, ValueAnimationTransition } from "motion/react";
import { cn } from "cn";

const NBSP = "\u00A0";
const glyph = (char: string) => (char === " " ? NBSP : char);

const EASE = [0.34, 1.56, 0.64, 1] as const;

const wobble = (i: number, salt: number) => {
  const n = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43_758.5453;

  return (n - Math.floor(n)) * 2 - 1;
};

const settleWidth = (
  width: MotionValue<number | "auto">,
  target: number,
  transition: ValueAnimationTransition<number | "auto">,
) => {
  if (width.get() === "auto") {
    width.set(target);

    return null;
  }

  return animate(width, target, transition);
};

const measureChar = (els: Map<string, HTMLSpanElement>, char: string) => {
  if (!char) {
    return 0;
  }

  const el = els.get(glyph(char));

  return el ? el.getBoundingClientRect().width : null;
};

interface ChromaticOptions {
  from?: number;
  spread?: number;
  saturation?: number;
  lightness?: number;
  /** Explicit color stops swept across the line instead of a hue ramp. */
  palette?: string[];
}

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
      if (palette.length === 1) {
        return palette[0] ?? "";
      }

      const pos = t * (palette.length - 1);
      const lower = Math.min(Math.floor(pos), palette.length - 2);
      const mix = Math.round((pos - lower) * 100);
      const a = palette[lower] ?? "";
      const b = palette[lower + 1] ?? "";

      if (mix <= 0) {
        return a;
      }

      if (mix >= 100) {
        return b;
      }

      return `color-mix(in oklab, ${b} ${mix}%, ${a})`;
    }

    return `hsl(${(from + t * spread) % 360} ${saturation}% ${lightness}%)`;
  };

interface RollingTextProps {
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
}

interface RollingColumnProps {
  candidates: string[];
  char: string;
  wordKey: number;
  enterY: string;
  exitY: string;
  tilt: number;
  delay: number;
  exitOffset: number;
  duration: number;
  tint?: string;
  colorFade: number;
}

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
  const width = useMotionValue<number | "auto">("auto");

  useEffect(() => {
    const target = measureChar(candidateEls.current, char);

    const controls =
      target === null
        ? null
        : settleWidth(width, target, { delay: delay + exitOffset, duration, ease: "easeOut" });

    return () => {
      controls?.stop();
    };
  }, [char, width, delay, exitOffset, duration]);

  useEffect(() => {
    const sizer = sizerRef.current;

    const observer =
      "ResizeObserver" in window
        ? new ResizeObserver(() => {
            const target = measureChar(candidateEls.current, char);

            if (target !== null) {
              width.set(target);
            }
          })
        : null;

    if (sizer) {
      observer?.observe(sizer);
    }

    return () => {
      observer?.disconnect();
    };
  }, [char, width]);

  const roll = { delay: delay + exitOffset, duration, ease: EASE };
  const exitRoll = { delay, duration, ease: EASE };

  const initial: TargetAndTransition = {
    rotate: tilt,
    y: enterY,
    ...(tint !== undefined && tint !== "" && { "--flash": 1 }),
  };

  const enter: TargetAndTransition = {
    rotate: 0,
    y: "0%",
    ...(tint !== undefined && tint !== "" && { "--flash": 0 }),
    transition: {
      rotate: roll,
      y: roll,
      ...(tint !== undefined &&
        tint !== "" && {
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
      className="relative -my-[0.2em] inline-flex min-w-0 justify-center overflow-x-visible py-[0.2em] [overflow-y:clip]"
    >
      <span ref={sizerRef} className="invisible inline-grid">
        {(candidates.length ? candidates : [NBSP]).map((candidate) => (
          <span
            key={candidate}
            ref={(el) => {
              if (el) {
                candidateEls.current.set(candidate, el);
              } else {
                candidateEls.current.delete(candidate);
              }
            }}
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
            tint !== undefined && tint !== ""
              ? {
                  color: `color-mix(in oklab, ${tint} calc(var(--flash) * 100%), currentColor)`,
                }
              : undefined
          }
          initial={initial}
          animate={enter}
          exit={{
            rotate: -tilt,
            transition: { rotate: exitRoll, y: exitRoll },
            y: exitY,
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
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const id =
      reduceMotion === true || words.length <= 1
        ? undefined
        : setInterval(() => {
            setIndex((i) => (i + 1) % words.length);
          }, interval);

    return () => {
      clearInterval(id);
    };
  }, [reduceMotion, words.length, interval]);

  const columns = useMemo(() => {
    let len = 0;

    for (const word of words) {
      len = Math.max(len, word.length);
    }

    return Array.from({ length: len }, (_, i) =>
      [
        ...new Set(
          words.flatMap((word) => {
            const candidate = word[i];

            return candidate === undefined ? [] : [candidate];
          }),
        ),
      ].map(glyph),
    );
  }, [words]);

  const len = columns.length;
  const word = words[index] ?? "";
  const enterY = direction === "down" ? "-100%" : "100%";
  const exitY = direction === "down" ? "100%" : "-100%";

  if (reduceMotion === true) {
    return <span className={cn("inline-flex", className)}>{words[0]}</span>;
  }

  return (
    <span className={cn("inline-flex", className)}>
      <span className="sr-only">{words[0]}</span>
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

interface RollingLabelProps {
  words: string[];
  index: number;
  fluid?: boolean;
  className?: string;
}

const LABEL_ROLL = { duration: 0.3, ease: EASE };

export const RollingLabel = ({ words, index, fluid = true, className }: RollingLabelProps) => {
  const reduceMotion = useReducedMotion();
  const label = words[index] ?? words[0] ?? "";
  const width = useMotionValue<number | "auto">("auto");

  const measureSizer = useCallback(
    (el: HTMLSpanElement) => {
      const controls = settleWidth(width, el.getBoundingClientRect().width, {
        duration: 0.3,
        ease: "easeOut",
      });

      return () => {
        controls?.stop();
      };
    },
    [width],
  );

  if (reduceMotion === true) {
    return <span className={cn("inline-flex", className)}>{label}</span>;
  }

  if (!fluid) {
    return (
      <span className={cn("relative grid grid-cols-1 [overflow-y:clip]", className)}>
        {words.map((candidate, i) => (
          <span key={i} aria-hidden className="invisible" style={{ gridArea: "1 / 1" }}>
            {candidate}
          </span>
        ))}
        <AnimatePresence initial={false}>
          <motion.span
            key={label}
            className="absolute inset-0 will-change-transform"
            initial={{ y: "-110%" }}
            animate={{ y: "0%" }}
            exit={{ y: "110%" }}
            transition={LABEL_ROLL}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    );
  }

  return (
    <motion.span
      style={{ width }}
      className={cn("relative -my-[0.2em] inline-grid py-[0.2em] [overflow:clip]", className)}
    >
      <span
        key={label}
        ref={measureSizer}
        aria-hidden
        className="invisible whitespace-nowrap"
        style={{ gridArea: "1 / 1", justifySelf: "start" }}
      >
        {label}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={label}
          className="absolute inset-0 flex items-center whitespace-nowrap will-change-transform"
          initial={{ y: "-115%" }}
          animate={{ y: "0%" }}
          exit={{ y: "115%" }}
          transition={LABEL_ROLL}
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
};
