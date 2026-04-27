import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";

const requireAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = getServerContext();
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });

  if (!session) {
    throw redirect({ to: "/auth/login", search: { callbackUrl: "/admin" } });
  }
  if (session.user.role !== "admin") {
    throw redirect({ to: "/" });
  }

  return { userName: session.user.name };
});

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
  beforeLoad: () => requireAdmin(),
  component: () => (
    <main className="container mx-auto max-w-4xl px-4 py-10">
      <Outlet />
    </main>
  ),
});
