import { createFileRoute } from "@tanstack/react-router";

import { InviteAdmin } from "@/components/admin/invite-admin";

export const Route = createFileRoute("/admin/invites")({
  head: () => ({ meta: [{ title: "Invites — Vibedgames Admin" }] }),
  component: InviteAdmin,
});
