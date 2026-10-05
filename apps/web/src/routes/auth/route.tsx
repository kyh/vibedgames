import { z } from "zod";
import { createFileRoute, Outlet } from "@tanstack/react-router";

// Loose: an MCP connector's sign-in arrives with a signed OAuth query
// (client_id, scope, sig, ...) that has to survive login ⇄ register intact.
const authSearchSchema = z.looseObject({
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
