"use client";

import { useState } from "react";
import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";

import { useSandboxStore } from "@/components/chat/sandbox-store";
import { authClient } from "@/lib/auth-client";
import { BuildView } from "./build-view";
import { featuredGames } from "./data";
import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";
import { useUiStore } from "./ui-store";
import { WaitlistDailog } from "./waitlist-form";

export const Composer = () => {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const { view, setView, setCurrentIndex } = useUiStore();
  const { reset, url } = useSandboxStore();

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
            view === "play" && "text-foreground",
          )}
          onClick={() => {
            if (view === "discover") {
              // Find the index of the current game URL
              const currentGameIndex = featuredGames.findIndex(
                (game) => game.url === url,
              );
              if (currentGameIndex !== -1) {
                setCurrentIndex(currentGameIndex);
              }
              setView("play");
            } else {
              setView("discover");
            }
          }}
        >
          Play
          {(view === "play" || view === "discover") && (
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
