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

/**
 * Defocus crossfade: content blurs out as it leaves and the next thing fades
 * in behind it. Spread onto a keyed `AnimatePresence` child. The outgoing half
 * is quicker than the incoming so the two overlap as one move instead of
 * reading as two beats.
 *
 * Only the EXIT carries `filter`, and that is deliberate. Motion leaves the
 * final value on the element as an inline style, so animating a blur *in*
 * parks a `filter: blur(0px)` on it forever — and any filtered ancestor
 * disables `backdrop-filter` on everything inside it. That silently flattens
 * frosted surfaces (see `inputVariants`' frosted variant) in whatever the
 * panel happens to contain. An exiting element is unmounted moments later, so
 * it can blur freely; a resting one must stay filter-free.
 */
export const BLUR_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.22, ease: EASE_OUT } },
  exit: { opacity: 0, filter: "blur(4px)", transition: { duration: 0.12, ease: EASE_OUT } },
};
