import { Logo } from "@repo/ui/components/logo";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/build-2")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: Build2Page,
});

const features = [
  {
    icon: "⌘",
    title: "Deploy",
    description:
      "Say /deploy to your LLM. Your game is built and live in seconds at your-game.vibedgames.com.",
  },
  {
    icon: "⚡",
    title: "Multiplayer",
    description:
      "Ask for multiplayer and it's wired up. Real-time state sync, host authority, player management — handled.",
  },
  {
    icon: "◈",
    title: "Hosting",
    description:
      "Every game gets a subdomain. Global CDN, instant loads, no infra to think about.",
  },
  {
    icon: "▣",
    title: "Discovery",
    description:
      "Your game appears on vibedgames.com. Players find it, play it, share it.",
  },
  {
    icon: "⊘",
    title: "No Config",
    description:
      "No build configs, no server setup, no CI pipelines. The LLM handles all of it through skills.",
  },
  {
    icon: "◉",
    title: "LLM-Native",
    description:
      "Every feature is a skill your LLM already knows. You describe, it executes.",
  },
];

function Build2Page() {
  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <nav className="fixed top-0 left-0 z-20 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="mx-auto max-w-4xl px-6 pt-28 pb-20 font-mono">
        <div className="mb-16 text-center">
          <h1 className="mb-4 text-3xl font-light tracking-tight sm:text-4xl">
            Everything you need to ship a game
          </h1>
          <p className="text-muted-foreground mx-auto max-w-lg text-sm leading-relaxed">
            You talk to your LLM. We give it the tools to build, deploy, and add
            multiplayer to your game — no config, no setup, no infra.
          </p>
        </div>

        <div className="mb-16 flex justify-center">
          <div className="bg-secondary/50 rounded-lg border border-white/5 px-5 py-3 text-sm">
            <span className="text-muted-foreground select-none">$ </span>
            <span className="text-foreground">npx vibedgames skills .</span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-lg border border-white/5 bg-white/[0.02] p-5 transition hover:border-white/10 hover:bg-white/[0.04]"
            >
              <div className="text-muted-foreground mb-3 text-lg">
                {feature.icon}
              </div>
              <h3 className="mb-1.5 text-sm font-medium">{feature.title}</h3>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
