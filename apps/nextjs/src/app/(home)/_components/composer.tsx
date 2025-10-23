"use client";

import { useState } from "react";
import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";
import { create } from "zustand";

import { authClient } from "@/lib/auth-client";
import { BuildView } from "./build-view";
import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";
import { WaitlistDailog } from "./waitlist-form";

type View = "build" | "play" | "discover";

const uiState = create<{
  view: View;
  setView: (view: View) => void;
}>((set) => ({
  view: "play",
  setView: (view) => set({ view }),
}));

export const Composer = () => {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const { view, setView } = uiState();
  const session = authClient.useSession();
  const user = session.data?.user;

  return (
    <>
      {view === "build" && <BuildView />}
      {view === "discover" && <DiscoverView />}
      {view === "play" && <PlayView />}
      <div className="relative flex gap-2 font-mono text-xs uppercase">
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "play" && "text-foreground",
          )}
          onClick={() => {
            if (view === "discover") {
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

export { uiState };
