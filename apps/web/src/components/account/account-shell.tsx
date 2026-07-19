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
 * and springs to whatever the pointer is over, returning home on leave.
 * Active is still legible via icon color when the disc is elsewhere.
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
            className="text-muted-foreground hover:text-foreground data-[active=true]:text-foreground relative rounded-full p-2 transition-colors duration-100"
            data-active={isActive}
          />
        }
      >
        {showDisc && (
          <motion.span
            layoutId="rail-disc"
            transition={{ type: "spring", bounce: 0.15, duration: 0.3 }}
            className="absolute inset-0 rounded-full bg-white/10 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
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
 * All chrome is fixed — logo top-left, avatar menu top-right, island rail
 * mid-left sharing the logo's vertical axis (both center in the same
 * `w-11` gutter) — so only the content column scrolls. One page-level
 * `animate-page-enter` handles the entrance; do NOT wrap any of this in
 * FadeInBlur (its lingering inline `filter` would break the rail's
 * backdrop-blur and re-anchor the fixed chrome).
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
      <div className="motion-safe:animate-page-enter">
        <div className="fixed top-[26px] left-4 z-10 flex w-11 justify-center sm:left-6">
          <Link to="/" aria-label="Vibedgames home">
            <Logo className="text-foreground h-5 w-auto" />
          </Link>
        </div>

        <div className="fixed top-5 right-4 z-10 sm:right-6">
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

        <div className="fixed top-1/2 left-4 z-10 -translate-y-1/2 sm:left-6">
          <nav
            aria-label="Account"
            onMouseLeave={() => setHoveredRail(null)}
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

        <div className="min-h-dvh overflow-auto px-6 pt-28 pb-16">
          <div className="mx-auto max-w-3xl space-y-16">{children}</div>
        </div>
      </div>
    </TooltipProvider>
  );
}
