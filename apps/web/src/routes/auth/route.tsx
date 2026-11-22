import { z } from "zod";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { socialSignInProviders } from "@/auth/server";

const authSearchSchema = z.looseObject({
  callbackUrl: z.string().optional(),
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
  head: () => ({
    meta: [{ title: "Authentication" }, { content: "noindex, nofollow", name: "robots" }],
  }),
  loader: async () => ({ socialProviders: await fetchSocialProviders() }),
  staleTime: Infinity,
  validateSearch: authSearchSchema,
});
