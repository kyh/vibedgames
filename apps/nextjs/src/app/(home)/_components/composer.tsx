"use client";

import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";
import { create } from "zustand";

import { BuildView } from "./build-view";
import { DiscoverView } from "./discover-view";
import { PlayView } from "./play-view";

type View = "build" | "play" | "discover";

const uiState = create<{
  view: View;
  setView: (view: View) => void;
}>((set) => ({
  view: "play",
  setView: (view) => set({ view }),
}));

export const Composer = () => {
  const { view, setView } = uiState();

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
          onClick={() => setView("build")}
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
    </>
  );
};

export { uiState };
