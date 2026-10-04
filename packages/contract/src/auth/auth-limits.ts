// No zod here: the web signup form imports these, and a schema module would put
// its validators in every page's client chunk.

/**
 * Length of CLI device-codes and invite codes. The single source of truth for
 * this contract: the web signup form enters invite codes through a fixed-length
 * alphanumeric OTP field of this size, so minting (the service's
 * `generateShortCode`) and redemption (the form) can't drift.
 */
export const INVITE_CODE_LENGTH = 6;

/** Most codes mintable in a single batch — guards against pathological inputs. */
export const MAX_INVITE_BATCH = 100;
