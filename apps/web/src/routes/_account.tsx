import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { leaveFor, signInHref } from "@/lib/leave-for";
import { AccountShell } from "@/components/account/account-shell";

const requireAuth = createServerFn({ method: "GET" })
  .validator((redirectTo: string) => redirectTo)
  .handler(async ({ data: redirectTo }) => {
    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });

    if (!session) {
      leaveFor(signInHref(redirectTo));
    }

    return {
      user: {
        email: session.user.email,
        isAdmin: session.user.role === "admin",
        name: session.user.name,
      },
    };
  });

const AccountLayout = () => {
  const { user } = Route.useRouteContext();

  return (
    <AccountShell user={user}>
      <Outlet />
    </AccountShell>
  );
};

export const Route = createFileRoute("/_account")({
  beforeLoad: async ({ location }) => await requireAuth({ data: location.pathname }),
  component: AccountLayout,
  head: () => ({ meta: [{ content: "noindex, nofollow", name: "robots" }] }),
});
