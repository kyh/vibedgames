import { cn } from "@repo/ui/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";

import { Route } from "@/routes/index";
import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";

type Props = {
  onHover: (url: string) => void;
};

export const Composer = ({ onHover }: Props) => {
  const { view } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const setView = (v: "play" | "discover") =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, view: v }) });

  return (
    <>
      {view === "play" && <PlayView />}
      {view === "discover" && <DiscoverView onHover={onHover} />}
      <div className="relative flex gap-2 font-mono text-xs uppercase">
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "discover" && "text-foreground",
          )}
          onClick={() => setView("discover")}
        >
          Discover
          {view === "discover" && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "play" && "text-foreground",
          )}
          onClick={() => setView("play")}
        >
          Play
          {view === "play" && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
        <Link
          to="/build-1"
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
          )}
        >
          Build
        </Link>
      </div>
    </>
  );
};
