/**
 * Length of credit codes. The single source of truth for
 * this contract: the settings page enters credit codes through a fixed-length
 * alphanumeric OTP field of this size, so minting (the service's
 * `generateShortCode`) and redemption (the form) can't drift.
 */
export const INVITE_CODE_LENGTH = 6;

/** Most codes mintable in a single batch — guards against pathological inputs. */
export const MAX_INVITE_BATCH = 100;
