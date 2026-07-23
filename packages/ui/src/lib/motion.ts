/**
 * House motion grammar shared by `useShake` and any state-driven shake
 * (e.g. the OTP input), so every error nudge in the app moves the same way.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export const SHAKE_KEYFRAMES = { x: [0, 6, -6, 4, 0] };

export const SHAKE_TRANSITION = {
  duration: 0.28,
  times: [0, 0.2857, 0.5714, 0.7857, 1],
  ease: EASE_OUT,
};
