import { useState } from "react";
import { cn } from "@repo/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";

import { useGameParam, usePathname } from "@/lib/use-game-param";
import { WaitlistDialog } from "./waitlist-form";

const bracketClass =
  "absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']";

const tabClass = (active: boolean) =>
  cn(
    "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
    active && "text-foreground",
  );

type NavTabProps = {
  to: "/" | "/discover";
  label: string;
  active: boolean;
  search: { game?: string };
};

const NavTab = ({ to, label, active, search }: NavTabProps) => (
  <Link to={to} search={search} className={tabClass(active)}>
    {label}
    {active && <motion.div layoutId="nav-bracket" className={bracketClass} />}
  </Link>
);

export const Nav = () => {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const pathname = usePathname();
  const game = useGameParam();
  const search = game ? { game } : {};

  return (
    <>
      <nav className="fixed bottom-0 left-0 z-10 flex gap-2 px-4 py-6 font-mono text-xs">
        <NavTab to="/discover" label="Discover" active={pathname === "/discover"} search={search} />
        <NavTab to="/" label="Play" active={pathname === "/"} search={search} />
        <button className={tabClass(false)} onClick={() => setWaitlistOpen(true)}>
          Build
        </button>
      </nav>
      <WaitlistDialog waitlistOpen={waitlistOpen} setWaitlistOpen={setWaitlistOpen} />
    </>
  );
};
