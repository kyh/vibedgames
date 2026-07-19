import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_account/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/users" });
  },
});
