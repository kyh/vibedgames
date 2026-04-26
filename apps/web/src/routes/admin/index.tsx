import { createFileRoute } from "@tanstack/react-router";

import { InviteAdmin } from "@/components/admin/invite-admin";
import { UserAdmin } from "@/components/admin/user-admin";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
  component: () => (
    <div className="space-y-12">
      <UserAdmin />
      <InviteAdmin />
    </div>
  ),
});
