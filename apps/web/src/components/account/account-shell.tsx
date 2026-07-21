import { useState } from "react";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Gamepad2Icon, LogOutIcon, SettingsIcon, ShieldIcon } from "lucide-react";
import { motion } from "motion/react";

import { Avatar, AvatarFallback } from "@repo/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Logo } from "@repo/ui/components/logo";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";

import { authClient } from "@/auth/client";

export type ShellUser = {
  name: string;
  email: string;
  isAdmin: boolean;
};

const railItems = [
  { to: "/home", label: "Home", icon: Gamepad2Icon, adminOnly: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, adminOnly: false },
  { to: "/admin", label: "Admin", icon: ShieldIcon, adminOnly: true },
] as const;

/**
 * One shared highlight disc for the whole rail: it sits on the active route
 * and springs to whatever the pointer or keyboard focus is over, returning
 * home on leave. The disc IS the highlight — hover, focus, and active get
 * the identical treatment (disc + foreground icon), never separate styles.
 * Its surface must stay in lockstep with the games-list row highlight in
 * home.tsx (same bg/shadow/blur) — one highlight recipe app-wide.
 */
function RailLink({
  to,
  label,
  icon: Icon,
  hovered,
  onHover,
}: {
  to: string;
  label: string;
  icon: typeof Gamepad2Icon;
  hovered: string | null;
  onHover: (to: string) => void;
}) {
  const matchRoute = useMatchRoute();
  const isActive = matchRoute({ to, fuzzy: true }) !== false;
  const showDisc = hovered === null ? isActive : hovered === to;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={to}
            aria-label={label}
            onMouseEnter={() => onHover(to)}
            onFocus={() => onHover(to)}
            className={`relative rounded-full p-2 outline-none transition-colors duration-100 ${
              showDisc ? "text-foreground" : "text-muted-foreground"
            }`}
          />
        }
      >
        {showDisc && (
          <motion.span
            layoutId="rail-disc"
            transition={{ type: "spring", bounce: 0.15, duration: 0.3 }}
            className="absolute inset-0 rounded-full bg-white/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-sm"
          />
        )}
        <Icon className="relative size-4" />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

const initials = (user: ShellUser): string => {
  const source = user.name.trim() || user.email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

/**
 * Shared chrome for every logged-in page (/home, /settings, /admin/*).
 * One grid: two symmetric `2.75rem` gutter columns (so the content column
 * stays viewport-centered) around the content. Chrome is sticky inside the
 * full-height gutter cells — logo top-left, rail viewport-centered on the
 * logo's axis, avatar top-right — so the document scrolls normally and the
 * chrome stays pinned without `position: fixed`. Below `sm` the content
 * spans the full grid and the rail floats over it, as before. Deliberately
 * no page-entrance animation: loading states are the skeletons' job. Do NOT
 * wrap any of this in FadeInBlur (its lingering inline `filter` would break
 * the rail's backdrop-blur).
 */
export function AccountShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const navigate = useNavigate();
  const [hoveredRail, setHoveredRail] = useState<string | null>(null);

  const signOut = async () => {
    await authClient.signOut();
    await navigate({ to: "/", replace: true });
  };

  return (
    <TooltipProvider delay={300}>
      <div className="grid min-h-dvh grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] px-4 sm:px-6">
        <div className="pointer-events-none z-10 col-start-1 row-start-1 flex flex-col items-center gap-4">
          <div className="pointer-events-auto sticky top-[26px] flex w-11 justify-center">
            <Link to="/" aria-label="Vibedgames home">
              <Logo className="text-foreground h-5 w-auto" />
            </Link>
          </div>

          <div className="pointer-events-auto sticky top-1/2 -translate-y-1/2">
            <nav
              aria-label="Account"
              onMouseLeave={() => setHoveredRail(null)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setHoveredRail(null);
              }}
              className="bg-input/40 flex w-11 flex-col items-center gap-1 rounded-full p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.4),0_2px_6px_rgb(0_0_0/0.3)] backdrop-blur-sm"
            >
              {railItems
                .filter((item) => !item.adminOnly || user.isAdmin)
                .map((item) => (
                  <RailLink
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    hovered={hoveredRail}
                    onHover={setHoveredRail}
                  />
                ))}
            </nav>
          </div>
        </div>

        <div className="pointer-events-none z-10 col-start-3 row-start-1">
          <div className="pointer-events-auto sticky top-5 flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >
                <Avatar size="default">
                  <AvatarFallback>{initials(user)}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="font-mono">{user.email}</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <main className="col-span-full row-start-1 px-2 pt-28 pb-16 sm:col-span-1 sm:col-start-2 sm:px-4">
          <div className="mx-auto max-w-3xl space-y-16">{children}</div>
        </main>
      </div>
    </TooltipProvider>
  );
}
