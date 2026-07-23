"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MotionConfig, motion } from "motion/react";

import { cn } from "@repo/ui/lib/utils";

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
//     NATIVE caret — the active cell is derived from selectionStart, never
//     stored beside it. Select-all paints all cells selected, because a
//     selection range maps to a cell range.
//
// Verification: pass `verify` (sync or async — hit your API). A full code
// drives the little state machine: right → the cells cascade green left to
// right, then `onSuccess` fires; wrong → the row shakes, the characters drop
// out one by one, then the field clears and hands the caret back.
//
// Animation via motion/react; honours prefers-reduced-motion.

const EASE = [0.22, 1, 0.36, 1] as const;
const SHAKE_S = 0.38; // wrong code: the row shake
const DROP_S = 0.24; // each character's fall-out
const STAGGER_S = 0.045; // per-character clear offset
const FILL_S = 0.055; // per-cell success cascade offset
const VERIFY_DELAY_MS = 320; // beat so the last character is seen landing

const OTP_VARS: CSSProperties & Record<`--${string}`, string> = {
  "--otp-cell-w": "2.5rem",
  "--otp-cell-h": "3rem",
  "--otp-gap": "0.5rem",
};

const SANITIZE: Record<"numeric" | "alphanumeric", RegExp> = {
  numeric: /[^0-9]/g,
  alphanumeric: /[^a-zA-Z0-9]/g,
};

function OTPInput({
  length,
  defaultValue = "",
  validationType = "numeric",
  normalizeValue,
  verify,
  onValueChange,
  onSuccess,
  mask = false,
  group = false,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type"> & {
  length: number;
  defaultValue?: string;
  validationType?: "numeric" | "alphanumeric";
  /** Post-sanitize pass, e.g. uppercasing. Applied to typed, pasted and default values alike. */
  normalizeValue?: (value: string) => string;
  /** Your check — sync or async (hit your API); return whether the code is right. */
  verify?: (value: string) => boolean | Promise<boolean>;
  onValueChange?: (value: string) => void;
  /** Fires after the success cascade has played. */
  onSuccess?: (value: string) => void;
  /** Paint • instead of the character. */
  mask?: boolean;
  /** Split the row in half, like codes read aloud. */
  group?: boolean;
}) {
  const sanitize = (raw: string) => {
    const stripped = raw.replace(SANITIZE[validationType], "").slice(0, length);
    return normalizeValue ? normalizeValue(stripped) : stripped;
  };

  const [value, setValue] = useState(() => sanitize(defaultValue));
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<"idle" | "success" | "error">("idle");

  const inputRef = useRef<HTMLInputElement>(null);
  const settleTimerRef = useRef<number>(0);

  // Callbacks live in refs so an inline `verify` closure doesn't churn the
  // verification effect on every parent render.
  const verifyRef = useRef(verify);
  verifyRef.current = verify;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const chars = value.split("");
  const collapsed = sel.start === sel.end;
  const caretCell = Math.min(sel.start, length - 1);
  const groupAt = Math.ceil(length / 2);

  function syncSel() {
    const el = inputRef.current;
    if (!el) return;
    setSel({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
  }

  // The active cell is DERIVED from the native selection — arrows, backspace,
  // select-all all just move the real caret and the paint follows.
  useEffect(() => {
    const onSelectionChange = () => {
      if (document.activeElement === inputRef.current) syncSel();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    if (state !== "idle") return;
    // One sanitize pass covers typing, paste and autofill: "DEV 123",
    // "dev-123" and "DEV123" all become the same characters.
    const next = sanitize(event.target.value);
    setValue(next);
    onValueChange?.(next);
    requestAnimationFrame(syncSel);
  }

  // Native click mapping is the one thing that's wrong for OTP (you can't
  // edit the middle of a code) — snap pointer focus to the end instead.
  function handleMouseDown(event: React.MouseEvent) {
    event.preventDefault();
    const el = inputRef.current;
    el?.focus({ preventScroll: true });
    el?.setSelectionRange(value.length, value.length);
    syncSel();
  }

  // A full code in → verify. A beat of delay so the last character is seen
  // landing before the row answers; the check itself may be async.
  useEffect(() => {
    if (state !== "idle" || value.length !== length) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      let ok: boolean;
      try {
        ok = await Promise.resolve(verifyRef.current ? verifyRef.current(value) : true);
      } catch {
        ok = false;
      }
      if (cancelled) return;
      if (ok) {
        setState("success");
        // Let the cascade play before the parent moves on.
        settleTimerRef.current = window.setTimeout(
          () => onSuccessRef.current?.(value),
          length * FILL_S * 1000 + 500,
        );
      } else {
        setState("error");
        // Shake, then the characters drop out one by one, then the field
        // clears and the caret comes back for another try.
        settleTimerRef.current = window.setTimeout(() => {
          setValue("");
          setState("idle");
          const el = inputRef.current;
          if (el && document.activeElement === el) {
            el.setSelectionRange(0, 0);
            syncSel();
          } else {
            setSel({ start: 0, end: 0 });
          }
        }, SHAKE_S * 1000 + length * STAGGER_S * 1000 + 260);
      }
    }, VERIFY_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, state, length]);

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  const cells = useMemo(
    () =>
      Array.from({ length }, (_, index) => {
        const char = chars[index];
        return {
          index,
          char,
          active: focused && state === "idle" && collapsed && caretCell === index,
          selected: focused && !collapsed && index >= sel.start && index < sel.end,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chars.join(""), length, focused, state, collapsed, caretCell, sel.start, sel.end],
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-slot="otp-input"
        data-state={state}
        className={cn("relative flex flex-col items-center", className)}
        style={OTP_VARS}
      >
        {/* Wrong code: the row shakes once, as one object. */}
        <motion.div
          className="relative flex gap-[var(--otp-gap)]"
          animate={state === "error" ? { x: [0, -6, 5, -4, 3, -1, 0] } : { x: 0 }}
          transition={{ duration: SHAKE_S, ease: EASE }}
        >
          {cells.map((cell) => (
            <div
              key={cell.index}
              className={cn(
                "flex h-[var(--otp-cell-h)] w-[var(--otp-cell-w)] items-center justify-center rounded-lg border font-mono text-lg font-medium tabular-nums backdrop-blur-sm",
                "transition-[border-color,background-color,color,box-shadow] duration-150",
                group && cell.index === groupAt && "ml-3",
                // the success cascade retimes the tint with a per-cell delay
                state === "success"
                  ? "border-green-500/70 bg-green-500/10 text-green-400"
                  : cell.selected
                    ? "border-input bg-primary/25 text-foreground" // a selection RANGE maps to a cell range — one input
                    : cell.active
                      ? "border-ring bg-input/40 text-foreground ring-2 ring-ring/30"
                      : state === "error"
                        ? "border-destructive/60 bg-input/40 text-destructive"
                        : "border-input bg-input/40 text-foreground",
              )}
              style={
                state === "success"
                  ? { transitionDelay: `${cell.index * FILL_S * 1000}ms` }
                  : undefined
              }
              aria-hidden="true"
            >
              {cell.char && (
                <motion.span
                  className="inline-block"
                  initial={false}
                  animate={
                    state === "success"
                      ? { scale: [1, 1.15, 1], y: 0, opacity: 1, filter: "blur(0px)" }
                      : state === "error"
                        ? { y: "0.5rem", opacity: 0, filter: "blur(2px)" }
                        : { scale: 1, y: 0, opacity: 1, filter: "blur(0px)" }
                  }
                  transition={
                    state === "success"
                      ? { duration: 0.3, ease: EASE, delay: cell.index * FILL_S }
                      : state === "error"
                        ? { duration: DROP_S, ease: "easeOut", delay: SHAKE_S + cell.index * STAGGER_S }
                        : { duration: 0 }
                  }
                >
                  {mask ? "•" : cell.char}
                </motion.span>
              )}
              {cell.active && !cell.char && (
                // The fake caret: a hard blink (steps, not a fade).
                <motion.span
                  className="h-5 w-[1.5px] rounded-[1px] bg-foreground"
                  animate={{ opacity: [1, 1, 0, 0] }}
                  transition={{ duration: 1.1, times: [0, 0.5, 0.5, 1], repeat: Infinity, ease: "linear" }}
                />
              )}
            </div>
          ))}

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
            aria-label={`${length}-character verification code`}
            spellCheck={false}
            autoCorrect="off"
            readOnly={state !== "idle"}
            onChange={handleChange}
            onMouseDown={handleMouseDown}
            onKeyUp={syncSel}
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
          {state === "success"
            ? "Code verified."
            : state === "error"
              ? "Wrong code, the field will clear. Try again."
              : ""}
        </span>
      </div>
    </MotionConfig>
  );
}

export { OTPInput };
