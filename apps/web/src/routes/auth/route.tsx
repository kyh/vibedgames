import { z } from "zod";
import { createFileRoute, Outlet } from "@tanstack/react-router";

const authSearchSchema = z.object({
  callbackUrl: z.string().optional(),
  nextPath: z.string().optional(),
  invite: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Authentication" }] }),
  validateSearch: authSearchSchema,
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <Outlet />
    </div>
  );
}
