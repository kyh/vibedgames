"use client";

import { useState } from "react";
import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";

import { useSandpackStore } from "@/components/chat/sandbox-store";
import { authClient } from "@/lib/auth-client";
import { BuildView } from "./build-view";
import { featuredGames } from "./data";
import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";
import { useUiStore } from "./ui-store";
import { WaitlistDailog } from "./waitlist-form";

export const Composer = () => {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const { view, setView, setCurrentIndex, currentIndex } = useUiStore();
  const { reset } = useSandpackStore();

  const session = authClient.useSession();
  const user = session.data?.user;

  return (
    <>
      {view === "play" && <PlayView />}
      {view === "build" && <BuildView />}
      {view === "discover" && <DiscoverView />}
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
          onClick={() => {
            setCurrentIndex(currentIndex);
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
            view === "build" && "text-foreground",
          )}
          onClick={() => {
            if (!user) {
              setWaitlistOpen(true);
              return;
            }
            setCurrentIndex(0);
            reset();
            setView("build");
          }}
        >
          Build
          {view === "build" && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
      </div>
      <WaitlistDailog
        waitlistOpen={waitlistOpen}
        setWaitlistOpen={setWaitlistOpen}
      />
    </>
  );
};
