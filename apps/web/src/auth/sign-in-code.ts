export const SIGN_IN_CODE_LENGTH = 6;

const CODE_ERRORS = new Map([
  ["INVALID_OTP", "That code isn't right. Check it and try again."],
  ["OTP_EXPIRED", "That code has expired. Send a new one."],
  ["TOO_MANY_ATTEMPTS", "Too many tries. Send a new code."],
]);

/** What a person reads when sending or checking an emailed code fails. */
export const codeErrorMessage = (error: { code?: string; message?: string }) =>
  CODE_ERRORS.get(error.code ?? "") ?? error.message ?? "Something went wrong. Try again.";
