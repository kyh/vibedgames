import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { getServerContext } from "@/auth/server";

const requireAuth = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = getServerContext();
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });

  if (!session) {
    throw redirect({ to: "/auth/login", search: { callbackUrl: "/settings" } });
  }

  return { userName: session.user.name };
});

export const Route = createFileRoute("/settings")({
  beforeLoad: () => requireAuth(),
  head: () => ({ meta: [{ title: "Settings — Vibedgames" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="min-h-dvh overflow-auto p-6">
      <div className="mx-auto max-w-3xl pt-10">
        <ApiKeySettings />
      </div>
    </div>
  );
}
