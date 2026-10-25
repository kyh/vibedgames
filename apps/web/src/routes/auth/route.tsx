import { z } from "zod";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { socialSignInProviders } from "@/auth/server";

// Loose: when a connecting app sends someone here to sign in, the OAuth
// provider's signed authorize query rides along and must survive untouched.
const authSearchSchema = z.looseObject({
  callbackUrl: z.string().optional(),
  // A credit code to redeem after sign-in (the name pre-launch invite links carry).
  invite: z.string().optional(),
  nextPath: z.string().optional(),
});

const fetchSocialProviders = createServerFn({ method: "GET" }).handler(() =>
  socialSignInProviders(),
);

const AuthLayout = () => (
  <div className="relative flex min-h-dvh items-center justify-center px-4">
    <Outlet />
  </div>
);

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
  head: () => ({ meta: [{ title: "Authentication" }] }),
  loader: async () => ({ socialProviders: await fetchSocialProviders() }),
  // Which providers are configured changes only on deploy.
  staleTime: Infinity,
  validateSearch: authSearchSchema,
});
