import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { InviteAdmin } from "@/components/admin/invite-admin";
import { UserAdmin } from "@/components/admin/user-admin";

const requireAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = getServerContext();
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });

  if (session?.user.role !== "admin") {
    redirect({ throw: true, to: "/home" });
  }
});

const AdminPage = () => (
  <div>
    <h1 className="sr-only">Admin</h1>
    <div className="divide-y divide-white/10">
      <UserAdmin />
      <InviteAdmin />
    </div>
  </div>
);

export const Route = createFileRoute("/_account/admin")({
  beforeLoad: async () => {
    await requireAdmin();
  },
  component: AdminPage,
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
});
