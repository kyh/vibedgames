import { Separator } from "@repo/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@repo/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { AppSidebar } from "@/components/admin/app-sidebar";
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
  beforeLoad: () => requireAdmin(),
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const { pathname } = useLocation();
  const section = pathname.split("/").filter(Boolean).at(1) ?? "users";

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="text-sm font-medium capitalize">{section}</h1>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-3xl">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
