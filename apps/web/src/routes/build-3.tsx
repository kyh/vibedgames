import { useState } from "react";
import { Logo } from "@repo/ui/logo";
import { cn } from "@repo/ui/utils";
import { createFileRoute, Link } from "@tanstack/react-router";

import { WaitlistDailog, WaitlistForm } from "@/components/game/waitlist-form";

export const Route = createFileRoute("/build-3")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: Build3Page,
});

const timeline = [
  {
    label: "Describe",
    title: "Tell your LLM what to build",
    description:
      'Just describe the game you want. "Make me a space shooter with retro pixel art." Your LLM generates the code, sets up the project, and gets it running locally.',
    visual: (
      <div className="bg-secondary/50 space-y-2 rounded-lg border border-white/5 p-4 text-xs">
        <div className="text-muted-foreground">you &gt; make me a space shooter with retro pixel art and power-ups</div>
        <div className="text-muted-foreground/50 mt-2">
          <div>Creating game project...</div>
          <div>Setting up Phaser 3 with pixel art config...</div>
          <div>Adding player ship, enemies, power-up system...</div>
          <div className="text-foreground mt-1">✓ Game running at localhost:5173</div>
        </div>
      </div>
    ),
  },
  {
    label: "Multiplayer",
    title: "Add multiplayer in one sentence",
    description:
      "Say \"add multiplayer\" and your LLM wires up real-time state sync using our SDK. Host-authoritative, automatic host migration, player management — all handled.",
    visual: (
      <div className="bg-secondary/50 space-y-2 rounded-lg border border-white/5 p-4 text-xs">
        <div className="text-muted-foreground">you &gt; add co-op multiplayer so friends can join</div>
        <div className="text-muted-foreground/50 mt-2">
          <div>Installing @vibedgames/multiplayer...</div>
          <div>Adding player state sync...</div>
          <div>Setting up host authority...</div>
          <div className="text-foreground mt-1">✓ Multiplayer ready — share link to invite players</div>
        </div>
      </div>
    ),
  },
  {
    label: "Deploy",
    title: "Ship with one command",
    description:
      "Tell your LLM to deploy, or just type /deploy. Your game is built, uploaded to our CDN, and live at your-game.vibedgames.com in seconds.",
    visual: (
      <div className="bg-secondary/50 space-y-2 rounded-lg border border-white/5 p-4 text-xs">
        <div className="text-muted-foreground">you &gt; /deploy</div>
        <div className="text-muted-foreground/50 mt-2">
          <div>Building for production...</div>
          <div>Uploading to vibedgames CDN...</div>
          <div className="text-foreground mt-1">✓ Live at space-shooter.vibedgames.com</div>
        </div>
      </div>
    ),
  },
  {
    label: "Play",
    title: "Your game is on the platform",
    description:
      "Players discover your game on vibedgames.com. Global CDN, instant loads, zero maintenance. Just share the link.",
    visual: (
      <div className="bg-secondary/50 flex items-center gap-3 rounded-lg border border-white/5 p-4 text-xs">
        <div className="bg-muted flex h-12 w-12 shrink-0 items-center justify-center rounded border border-white/5 text-lg">
          🚀
        </div>
        <div>
          <div className="text-foreground font-medium">Space Shooter</div>
          <div className="text-muted-foreground">space-shooter.vibedgames.com</div>
          <div className="text-muted-foreground/50 mt-0.5">multiplayer · 2 players online</div>
        </div>
      </div>
    ),
  },
];

function Build3Page() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <nav className="fixed top-0 left-0 z-20 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="mx-auto max-w-3xl px-6 pt-28 pb-20 font-mono">
        <div className="mb-20 text-center">
          <p className="text-muted-foreground mb-3 text-xs uppercase tracking-widest">
            Currently in private beta
          </p>
          <h1 className="mb-4 text-2xl font-light tracking-tight sm:text-3xl">
            From idea to live game in minutes
          </h1>
          <p className="text-muted-foreground text-sm">
            Talk to your LLM. It does the rest.
          </p>
        </div>

        <div className="relative">
          {/* Timeline line */}
          <div className="absolute top-0 bottom-0 left-[15px] w-px bg-white/10 sm:left-1/2 sm:-translate-x-px" />

          <div className="space-y-16">
            {timeline.map((item, i) => (
              <div key={item.label} className="relative">
                {/* Timeline dot */}
                <div className="absolute left-[11px] top-1 z-10 flex h-[9px] w-[9px] items-center justify-center rounded-full border border-white/20 bg-white/10 sm:left-1/2 sm:-translate-x-1/2" />

                <div
                  className={cn(
                    "grid gap-6 pl-10 sm:grid-cols-2 sm:gap-10 sm:pl-0",
                    i % 2 === 0 ? "sm:text-right" : "sm:direction-rtl",
                  )}
                >
                  <div
                    className={cn(
                      "sm:direction-ltr",
                      i % 2 === 0
                        ? "sm:pr-10"
                        : "sm:order-2 sm:pl-10",
                    )}
                  >
                    <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-widest">
                      {item.label}
                    </div>
                    <h3 className="mb-2 text-sm font-medium">
                      {item.title}
                    </h3>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                  <div
                    className={cn(
                      "sm:direction-ltr",
                      i % 2 === 0
                        ? "sm:order-2 sm:pl-10"
                        : "sm:pr-10",
                    )}
                  >
                    {item.visual}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-20 flex flex-col items-center gap-4">
          <p className="text-muted-foreground text-xs">Get early access</p>
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
