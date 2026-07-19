import { createFileRoute } from "@tanstack/react-router";

import { UserAdmin } from "@/components/admin/user-admin";

export const Route = createFileRoute("/_account/admin/users")({
  head: () => ({ meta: [{ title: "Users — Admin" }] }),
  component: UserAdmin,
});
