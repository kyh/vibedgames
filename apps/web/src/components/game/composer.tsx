import { useState } from "react";
import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";

import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";
import { useUiStore } from "./ui-store";
import { WaitlistDailog } from "./waitlist-form";

export const Composer = () => {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const { view, setView } = useUiStore();

  return (
    <>
      {view === "play" && <PlayView />}
      {view === "discover" && <DiscoverView />}
      <div className="relative flex gap-2 font-mono text-xs uppercase">
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "discover" && "text-foreground",
          )}
          onClick={() => {
            setView("discover");
          }}
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
          onClick={() => {
            setView("play");
          }}
        >
          Play
          {view === "play" && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
          )}
          onClick={() => {
            setWaitlistOpen(true);
          }}
        >
          Build
        </button>
      </div>
      <WaitlistDailog waitlistOpen={waitlistOpen} setWaitlistOpen={setWaitlistOpen} />
    </>
  );
};
