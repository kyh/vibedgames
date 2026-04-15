import { useState } from "react";
import { Logo } from "@repo/ui/logo";
import { createFileRoute, Link } from "@tanstack/react-router";

import { WaitlistDailog, WaitlistForm } from "@/components/game/waitlist-form";

export const Route = createFileRoute("/build-1")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: Build1Page,
});

const steps = [
  {
    prompt: "you",
    command: "make me a flappy bird clone with pixel art",
    description:
      "Describe your game to any LLM. No boilerplate, no setup, no config files. Just say what you want.",
  },
  {
    prompt: "you",
    command: "now add multiplayer so my friends can race",
    description:
      "Real-time multiplayer is one sentence away. The LLM wires up host-authoritative state sync using our SDK. No servers to manage.",
  },
  {
    prompt: "you",
    command: "/deploy",
    description:
      "One slash command. Your game is built, uploaded, and live at your-game.vibedgames.com. Done.",
  },
];

function Build1Page() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <nav className="fixed top-0 left-0 z-20 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="mx-auto max-w-2xl px-6 pt-28 pb-20 font-mono">
        <div className="mb-16">
          <p className="text-muted-foreground mb-2 text-xs uppercase tracking-widest">
            Currently in private beta
          </p>
          <h1 className="mb-4 text-2xl font-light tracking-tight sm:text-3xl">
            Vibe a game. Ship it. Play it.
          </h1>
          <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
            You talk to your LLM. It builds the game, adds multiplayer, and
            deploys it — all through skills that just work.
          </p>
        </div>

        <div className="space-y-12">
          {steps.map((step, i) => (
            <div key={i} className="group relative">
              <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-widest">
                Step {i + 1}
              </div>
              <div className="bg-secondary/50 rounded-lg border border-white/5 p-4">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground select-none">
                    {step.prompt} &gt;
                  </span>
                  <span className="text-foreground">{step.command}</span>
                </div>
              </div>
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                {step.description}
              </p>
              {i < steps.length - 1 && (
                <div className="border-muted ml-4 mt-4 h-8 border-l" />
              )}
            </div>
          ))}
        </div>

        <div className="mt-16 text-center">
          <div className="bg-secondary/50 mx-auto inline-flex items-center gap-2 rounded-lg border border-white/5 px-4 py-3">
            <span className="text-muted-foreground select-none">
              your-game &gt;
            </span>
            <span className="text-foreground animate-pulse">live at your-game.vibedgames.com</span>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center gap-4">
          <p className="text-muted-foreground text-xs">
            Get early access
          </p>
          <WaitlistForm />
        </div>
      </main>

      <WaitlistDailog
        waitlistOpen={waitlistOpen}
        setWaitlistOpen={setWaitlistOpen}
      />
    </div>
  );
}
