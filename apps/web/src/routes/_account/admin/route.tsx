import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { motion } from "motion/react";

import { getServerContext } from "@/auth/server";

/**
 * Admin subtree under the shared account shell. The parent `_account` layout
 * already guarantees a session; this layer only enforces the admin role and
 * adds the Users/Invites sub-nav.
 */
const requireAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = getServerContext();
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });

  if (session?.user.role !== "admin") {
    throw redirect({ to: "/games" });
  }
});

export const Route = createFileRoute("/_account/admin")({
  beforeLoad: () => requireAdmin(),
  head: () => ({ meta: [{ title: "Admin — Vibedgames" }] }),
  component: AdminLayout,
});

const sections = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/invites", label: "Invites" },
] as const;

function AdminTab({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition"
      activeProps={{ className: "text-foreground" }}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="admin-nav-bracket"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
          {label}
        </>
      )}
    </Link>
  );
}

function AdminLayout() {
  return (
    <div className="space-y-8">
      <nav aria-label="Admin sections" className="flex gap-2 font-mono text-xs">
        {sections.map((s) => (
          <AdminTab key={s.to} to={s.to} label={s.label} />
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
