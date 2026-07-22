import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { InviteAdmin } from "@/components/admin/invite-admin";
import { UserAdmin } from "@/components/admin/user-admin";

/**
 * Single admin page under the shared account shell. The parent `_account`
 * layout already guarantees a session; this route only enforces the admin
 * role. Users and invites stack as sections, same convention as /settings.
 */
const requireAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = getServerContext();
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });

  if (session?.user.role !== "admin") {
    throw redirect({ to: "/home" });
  }
});

export const Route = createFileRoute("/_account/admin")({
  beforeLoad: () => requireAdmin(),
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
  component: AdminPage,
});

function AdminPage() {
  return (
    <div>
      <h1 className="sr-only">Admin</h1>
      <div className="divide-y divide-white/10">
        <UserAdmin />
        <InviteAdmin />
      </div>
    </div>
  );
}
