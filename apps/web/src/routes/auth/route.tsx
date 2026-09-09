import { z } from "zod";
import { createFileRoute, Outlet } from "@tanstack/react-router";

const authSearchSchema = z.object({
  callbackUrl: z.string().optional(),
  invite: z.string().optional(),
  nextPath: z.string().optional(),
});

const AuthLayout = () => (
  <div className="relative flex min-h-dvh items-center justify-center px-4">
    <Outlet />
  </div>
);

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
  head: () => ({ meta: [{ title: "Authentication" }] }),
  validateSearch: authSearchSchema,
});
