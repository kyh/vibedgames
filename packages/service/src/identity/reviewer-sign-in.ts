import { z } from "zod";

/**
 * A fixed sign-in code for one address, for app-directory reviewers, who
 * must sign in without receiving email. The address is part of the secret:
 * keep it unguessable, since the code is only six digits.
 */
export interface ReviewerSignIn {
  code: string;
  email: string;
}

const reviewerSignIn = z.object({
  code: z.string().regex(/^\d{6}$/u),
  email: z.email().transform((email) => email.toLowerCase()),
});

/** Both halves set and well-formed, or no reviewer sign-in at all. */
export const reviewerSignInOf = (email: string | undefined, code: string | undefined) => {
  const parsed: ReviewerSignIn | undefined = reviewerSignIn.safeParse({ code, email }).data;

  return parsed;
};

export const isReviewer = (reviewer: ReviewerSignIn | undefined, email: string) =>
  reviewer !== undefined && email.toLowerCase() === reviewer.email;

/** better-auth's `generateOTP`: undefined falls back to a random code. */
export const reviewerCodeOf =
  (reviewer: ReviewerSignIn | undefined) =>
  ({ email, type }: { email: string; type: string }) =>
    type === "sign-in" && isReviewer(reviewer, email) ? reviewer?.code : undefined;
