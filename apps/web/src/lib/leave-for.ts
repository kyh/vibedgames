import { redirect } from "@tanstack/react-router";

/** Ends a loader, `beforeLoad` or server function in a redirect to `href`, which TanStack Router throws. */
export const leaveFor: (href: string) => never = (href) => {
  redirect({ href, throw: true });

  throw new Error("TanStack Router returned a redirect it was asked to throw");
};

/** The sign-in page, coming back to `callbackUrl` once signed in. */
export const signInHref = (callbackUrl: string) =>
  `/auth/login?${new URLSearchParams({ callbackUrl }).toString()}`;
