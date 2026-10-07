// No zod here: the settings page imports these, and a schema module would put
// its validators in every page's client chunk.

/** Smallest and largest checkout, in whole dollars. Stripe charges a fixed fee per payment, so tiny top-ups mostly pay Stripe. */
export const MIN_PURCHASE_USD = 5;
export const MAX_PURCHASE_USD = 500;

/** The amounts the settings page offers as one-click buttons. */
export const PURCHASE_PRESETS_USD = [10, 25, 50, 100] as const;
