import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getServerContext } from "@/auth/server";
import { AccountShell } from "@/components/account/account-shell";

/**
 * Layout for the logged-in pages (/home, /settings, /admin/*). Server-checks
 * the session once in beforeLoad; children read the user from route context
 * instead of re-guarding. The admin subtree adds its own role check on top.
 */
const requireAuth = createServerFn({ method: "GET" })
  .validator((redirectTo: string) => redirectTo)
  .handler(async ({ data: redirectTo }) => {
    const { auth } = getServerContext();
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });

    if (!session) {
      throw redirect({ search: { callbackUrl: redirectTo }, to: "/auth/login" });
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
  beforeLoad: ({ location }) => requireAuth({ data: location.pathname }),
  component: AccountLayout,
});
