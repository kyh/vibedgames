"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";

import { cn } from "cn";
import { EASE_OUT, SHAKE_KEYFRAMES, SHAKE_TRANSITION } from "@repo/ui/lib/motion";

// OTP segmented input — N cells, secretly ONE real input.
//
// Adapted from https://lab.moumen.dev/components/otp-segmented-input.
//
// The usual implementation is N <input>s wired together with JS focus hops.
// It looks right and behaves wrong: autofill can't fill it (the browser
// offers the code to ONE field), paste needs bespoke splitting, screen
// readers announce N unlabeled boxes, and half the keyboard is re-invented.
//
// This is the hard version: one real <input> stretched invisibly over the
// whole row (color and caret transparent — NOT display:none, it must stay
// focusable and autofillable), with the cells painted underneath from its
// value. Everything hard becomes free:
//
//   · Autofill just works — autocomplete="one-time-code" on a real,
//     visible-to-the-browser input.
//   · Paste just works — "DEV 123" lands in the input, one normalize pass
//     strips the junk, the cells repaint.
//   · Backspace walks backwards and ←/→ move the caret because they are the
//     NATIVE caret — the active cell is derived from the input's selection
//     (via onSelect), never stored beside it. Select-all paints all cells
//     selected, because a selection range maps to a cell range.
//
// Verification: pass `verify` (sync or async — hit your API). A full code
// drives the little state machine: right → the row nods once and the cells
// cascade green left to right, then `onSuccess` fires; wrong → the row shakes, the characters drop
// out one by one, then the field clears and hands the caret back. `verify`
// may resolve to a string to hand a server-canonicalized value to
// `onSuccess` instead of the typed one.
//
// Label the input externally (<label htmlFor> pairing with `id`, or pass
// `aria-label`) — the component does not name itself.
//
// Animation via motion/react; honours prefers-reduced-motion.

// wrong code: each character's fall-out
const DROP_S = 0.24;
// per-character clear offset
const STAGGER_S = 0.045;
// per-cell success cascade offset
const FILL_S = 0.055;
// beat so the last character is seen landing
const VERIFY_DELAY_MS = 320;
// a new character rising into its cell
const CHAR_IN_S = 0.14;
// Where the character starts, in px below its resting place. Measured, not
// guessed: at the cell's 3rem height and 1.125rem type, less than ~16px
// leaves the glyph floating inside the cell and the rise reads as a twitch.
const CHAR_IN_Y = 16;
// success: the row's nod
const BOUNCE_S = 0.65;

const OTP_VARS: React.CSSProperties & Record<`--${string}`, string> = {
  "--otp-cell-h": "3rem",
  "--otp-cell-w": "2.5rem",
  "--otp-gap": "0.5rem",
};

const SANITIZE = {
  alphanumeric: /[^a-zA-Z0-9]/gu,
  numeric: /[^0-9]/gu,
} satisfies Record<"numeric" | "alphanumeric", RegExp>;

type VerifyState = "idle" | "success" | "error";

const LIVE_MESSAGE: Record<VerifyState, string> = {
  error: "Wrong code, the field will clear. Try again.",
  idle: "",
  success: "Code verified.",
};

const idleTone = (selected: boolean, active: boolean) => {
  if (selected) {
    return "selected";
  }
  return active ? "active" : "idle";
};

// Ring + invalid values mirror `inputVariants` (input.tsx) so the cells stay
// in step with the system focus/error treatment.
const CELL_TONE = {
  active: "border-ring bg-input/40 text-foreground ring-3 ring-ring/50",
  error: "border-destructive/50 bg-input/40 text-destructive",
  idle: "border-input bg-input/40 text-foreground",
  // a selection RANGE maps to a cell range — one input
  selected: "border-input bg-primary/25 text-foreground",
  success: "border-success/60 bg-success/10 text-success",
} satisfies Record<"idle" | "active" | "selected" | VerifyState, string>;

/**
 * A character enters by rising into its cell, which is why the cells clip:
 * it starts below the floor rather than fading in on the spot. Keyed on the
 * character in the render below, so every new one plays it — including a
 * retype of the same digit into the same cell.
 *
 * Only `error` diverges: the row shakes first, then the characters drop back
 * out one by one, which is also how the field clears.
 */
const glyphMotion = (state: VerifyState, index: number) =>
  state === "error"
    ? {
        animate: { filter: "blur(2px)", opacity: 0, y: "0.5rem" },
        transition: {
          delay: SHAKE_TRANSITION.duration + index * STAGGER_S,
          duration: DROP_S,
          ease: "easeOut" as const,
        },
      }
    : {
        animate: { filter: "blur(0px)", opacity: 1, y: 0 },
        initial: { opacity: 0.2, y: CHAR_IN_Y },
        transition: { duration: CHAR_IN_S, ease: EASE_OUT },
      };

/**
 * Success is one gesture for the whole row — a short vertical nod, the field
 * agreeing with you — rather than a per-cell pop, which fought the green
 * tint already cascading left to right underneath it.
 */
const rowMotion = (state: VerifyState) => {
  if (state === "error") {
    return { animate: { ...SHAKE_KEYFRAMES, y: 0 }, transition: SHAKE_TRANSITION };
  }
  if (state === "success") {
    return {
      animate: { x: 0, y: [0, -10, 3, -4, 0] },
      transition: { duration: BOUNCE_S, ease: EASE_OUT, times: [0, 0.25, 0.5, 0.72, 1] },
    };
  }
  return { animate: { x: 0, y: 0 }, transition: SHAKE_TRANSITION };
};

const OTPInput = ({
  length,
  defaultValue = "",
  validationType = "numeric",
  normalizeValue,
  verify,
  onSuccess,
  group = false,
  className,
  ...props
}: Omit<
  React.ComponentProps<"input">,
  | "value"
  | "defaultValue"
  | "onChange"
  | "type"
  | "onFocus"
  | "onBlur"
  | "onSelect"
  | "onMouseDown"
  | "className"
  | "style"
  | "children"
> & {
  length: number;
  defaultValue?: string;
  validationType?: "numeric" | "alphanumeric";
  /** Post-sanitize pass, e.g. uppercasing. Applied to typed, pasted and default values alike. */
  normalizeValue?: (value: string) => string;
  /**
   * Your check — sync or async (hit your API). Return `true` for success,
   * `false` for failure, or a string to pass a canonicalized value to
   * `onSuccess` in place of the typed one.
   */
  verify?: (value: string) => boolean | string | Promise<boolean | string>;
  /** Fires after the success cascade has played. */
  onSuccess?: (value: string) => void;
  /** Split the row in half, like codes read aloud. */
  group?: boolean;
  className?: string;
}) => {
  const sanitize = (raw: string) => {
    const stripped = raw.replace(SANITIZE[validationType], "").slice(0, length);
    return normalizeValue ? normalizeValue(stripped) : stripped;
  };

  const [value, setValue] = useState(() => sanitize(defaultValue));
  const [sel, setSel] = useState({ end: 0, start: 0 });
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<VerifyState>("idle");

  const inputRef = useRef<HTMLInputElement>(null);
  const settleTimerRef = useRef<number>(0);
  const reducedMotion = useReducedMotion();

  const collapsed = sel.start === sel.end;
  const caretCell = Math.min(sel.start, length - 1);
  const groupAt = Math.ceil(length / 2);

  const syncSel = () => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    // Return the previous object when nothing moved so React can bail out.
    setSel((prev) => (prev.start === start && prev.end === end ? prev : { end, start }));
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // One sanitize pass covers typing, paste and autofill: "DEV 123",
    // "dev-123" and "DEV123" all become the same characters.
    setValue(sanitize(event.target.value));
  };

  // Native click mapping is the one thing that's wrong for OTP (you can't
  // edit the middle of a code) — snap pointer focus to the end instead.
  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const el = inputRef.current;
    el?.focus({ preventScroll: true });
    el?.setSelectionRange(value.length, value.length);
    syncSel();
  };

  const runVerify = useEffectEvent(async (candidate: string) => {
    try {
      return await Promise.resolve(verify ? verify(candidate) : true);
    } catch {
      return false;
    }
  });

  const settle = useEffectEvent((result: boolean | string, candidate: string) => {
    if (result === false) {
      setState("error");
      // Shake, then the characters drop out one by one, then the field
      // clears and the caret comes back for another try. Under reduced
      // motion neither animation plays, so don't sit through their timings.
      const clearDelay = reducedMotion
        ? 400
        : SHAKE_TRANSITION.duration * 1000 + length * STAGGER_S * 1000 + 260;
      settleTimerRef.current = window.setTimeout(() => {
        setValue("");
        setState("idle");
        const el = inputRef.current;
        if (el && document.activeElement === el) {
          el.setSelectionRange(0, 0);
          syncSel();
        } else {
          setSel({ end: 0, start: 0 });
        }
      }, clearDelay);
    } else {
      setState("success");
      // Let the cascade play before the parent moves on.
      const successDelay = reducedMotion ? 0 : length * FILL_S * 1000 + 500;
      settleTimerRef.current = window.setTimeout(
        () => onSuccess?.(result === true ? candidate : result),
        successDelay,
      );
    }
  });

  // A full code in → verify. A beat of delay so the last character is seen
  // landing before the row answers; the check itself may be async. Runs on
  // mount too, which is what auto-submits a prefilled `defaultValue`.
  useEffect(() => {
    if (state !== "idle" || value.length !== length) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await runVerify(value);
      if (!cancelled) {
        settle(result, value);
      }
    }, VERIFY_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, state, length]);

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-slot="otp-input"
        data-state={state}
        // Chrome's page translation rewrites the cells' text nodes (wrapping
        // them in <font>), which crashes React on the next update — and a
        // one-time code is never meaningful to translate.
        translate="no"
        className={cn("relative flex flex-col items-center", className)}
        style={OTP_VARS}
      >
        {/* Wrong code shakes the row, a right one nods it — either way it
            moves as one object, not as N cells. */}
        <motion.div className="relative flex gap-[var(--otp-gap)]" {...rowMotion(state)}>
          {Array.from({ length }, (_, index) => {
            const char = value[index];
            const active = focused && state === "idle" && collapsed && caretCell === index;
            const selected =
              focused && state === "idle" && !collapsed && index >= sel.start && index < sel.end;
            const tone = state === "idle" ? idleTone(selected, active) : state;
            return (
              <div
                key={index}
                className={cn(
                  // `overflow-hidden` is what makes the character rise INTO
                  // the cell — without it the glyph is visible below the
                  // border on its way up, and drops out through the floor.
                  "flex h-[var(--otp-cell-h)] w-[var(--otp-cell-w)] items-center justify-center overflow-hidden rounded-lg border font-mono text-lg font-medium tabular-nums backdrop-blur-sm",
                  "transition-[border-color,background-color,color,box-shadow] duration-150",
                  group && index === groupAt && "ml-3",
                  CELL_TONE[tone],
                )}
                // the success cascade retimes the tint with a per-cell delay
                style={
                  state === "success"
                    ? { transitionDelay: `${index * FILL_S * 1000}ms` }
                    : undefined
                }
                aria-hidden="true"
              >
                {char && (
                  <motion.span key={char} className="inline-block" {...glyphMotion(state, index)}>
                    {char}
                  </motion.span>
                )}
                {active &&
                  !char && (
                    // The fake caret: a hard blink (a step, not a fade).
                    <span className="h-5 w-[1.5px] animate-[otp-caret-blink_1.1s_linear_infinite] rounded-[1px] bg-foreground motion-reduce:animate-none" />
                  )}
              </div>
            );
          })}

          {/* THE component: one real input over the whole row. Transparent, not
              hidden — the browser must see it to autofill and focus it. No
              maxLength: it would truncate a formatted paste ("DEV 123" is 7
              chars) BEFORE the sanitize pass — the slice enforces length. */}
          <input
            ref={inputRef}
            data-slot="otp-input-control"
            className={cn(
              "absolute inset-0 h-full w-full cursor-text border-0 bg-transparent font-mono text-lg text-transparent outline-none",
              "pl-[calc(var(--otp-cell-w)/2-0.5ch)] [letter-spacing:calc(var(--otp-cell-w)+var(--otp-gap)-1ch)]",
              "selection:bg-transparent [caret-color:transparent]",
            )}
            type="text"
            value={value}
            inputMode={validationType === "numeric" ? "numeric" : "text"}
            autoComplete="one-time-code"
            autoCapitalize={validationType === "alphanumeric" ? "characters" : "off"}
            aria-invalid={state === "error" || undefined}
            spellCheck={false}
            autoCorrect="off"
            readOnly={state !== "idle"}
            onChange={handleChange}
            onSelect={syncSel}
            onMouseDown={handleMouseDown}
            onFocus={() => {
              setFocused(true);
              const el = inputRef.current;
              el?.setSelectionRange(value.length, value.length);
              syncSel();
            }}
            onBlur={() => setFocused(false)}
            {...props}
          />
        </motion.div>

        <span className="sr-only" aria-live="polite">
          {LIVE_MESSAGE[state]}
        </span>
      </div>
    </MotionConfig>
  );
};

export { OTPInput };
