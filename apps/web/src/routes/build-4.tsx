import { useState } from "react";
import { Logo } from "@repo/ui/logo";
import { cn } from "@repo/ui/utils";
import { createFileRoute, Link } from "@tanstack/react-router";

import { WaitlistDailog, WaitlistForm } from "@/components/game/waitlist-form";

export const Route = createFileRoute("/build-4")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: Build4Page,
});

const faqs = [
  {
    question: "How do I build a game?",
    answer:
      'Describe what you want to any LLM — Claude, ChatGPT, whatever you use. "Make me a platformer with double jump and pixel art." The LLM generates the code, scaffolds the project, and runs it locally. You iterate by talking to it.',
  },
  {
    question: "How does deployment work?",
    answer:
      'Tell your LLM to deploy, or type /deploy. It builds your game for production, uploads it to our global CDN, and your game is live at your-game.vibedgames.com. No CI pipeline, no Docker, no config. One command.',
  },
  {
    question: "How do I add multiplayer?",
    answer:
      '"Add multiplayer so my friends can play together." That\'s it. Your LLM installs our multiplayer SDK (@vibedgames/multiplayer) and wires up real-time state sync. We handle host authority, player management, and automatic host migration.',
  },
  {
    question: "What frameworks are supported?",
    answer:
      "Any browser game that builds to static HTML/JS. Phaser, Three.js, Pixi.js, p5.js, plain canvas — if it runs in a browser, it deploys to vibedgames. Your LLM picks the best framework for what you're building.",
  },
  {
    question: "Where does my game live?",
    answer:
      "Every game gets a subdomain: your-game.vibedgames.com. Served from a global CDN with instant loads. Games also appear on the vibedgames.com discover page where players can find and play them.",
  },
  {
    question: "Do I need to know how to code?",
    answer:
      "No. The whole point is that your LLM handles the code. You describe, iterate, and ship. If you do know how to code, you can always jump into the source — it's your project, running locally.",
  },
];

function Build4Page() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <nav className="fixed top-0 left-0 z-20 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="mx-auto max-w-xl px-6 pt-28 pb-20 font-mono">
        <div className="mb-10 text-center">
          <h1 className="mb-3 text-3xl font-light tracking-tight sm:text-4xl">
            Build. Deploy. Play.
          </h1>
          <p className="text-muted-foreground text-sm">
            All from a chat with your LLM.
          </p>
        </div>

        <div className="mb-12 flex justify-center">
          <WaitlistForm />
        </div>

        <div className="text-muted-foreground mb-6 text-center text-[10px] uppercase tracking-widest">
          How it works
        </div>

        <div className="divide-y divide-white/5">
          {faqs.map((faq, i) => (
            <div key={i}>
              <button
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                className="hover:text-foreground text-muted-foreground flex w-full items-center justify-between py-4 text-left text-sm transition"
              >
                <span>{faq.question}</span>
                <span
                  className={cn(
                    "ml-4 shrink-0 text-xs transition-transform duration-200",
                    openIndex === i && "rotate-45",
                  )}
                >
                  +
                </span>
              </button>
              <div
                className={cn(
                  "grid transition-all duration-200 ease-in-out",
                  openIndex === i
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <p className="text-muted-foreground pb-4 text-xs leading-relaxed">
                    {faq.answer}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <button
            onClick={() => setWaitlistOpen(true)}
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4 transition"
          >
            Join the waitlist
          </button>
        </div>
      </main>

      <WaitlistDailog
        waitlistOpen={waitlistOpen}
        setWaitlistOpen={setWaitlistOpen}
      />
    </div>
  );
}
