import { useRef } from "react";
import { Logo } from "@repo/ui/components/logo";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";

export const Route = createFileRoute("/build")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: BuildPage,
});

function AnimatedSection({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <motion.section
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
      className={className}
    >
      {children}
    </motion.section>
  );
}

function TypingLine({ text, delay = 0 }: { text: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-50px" });

  return (
    <div ref={ref} className="overflow-hidden">
      <motion.div
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : { opacity: 0 }}
        transition={{ delay, duration: 0.4 }}
      >
        {text}
      </motion.div>
    </div>
  );
}

function BuildPage() {
  return (
    <div className="relative min-h-dvh overflow-y-auto">
      <nav className="fixed top-0 left-0 z-20 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="font-mono">
        {/* Hero */}
        <section className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.21, 0.47, 0.32, 0.98] }}
          >
            <h1 className="mb-4 text-3xl font-light tracking-tight sm:text-5xl">
              Your LLM builds the game.
              <br />
              <span className="text-muted-foreground">We handle the rest.</span>
            </h1>
            <p className="text-muted-foreground mx-auto mb-10 max-w-md text-sm leading-relaxed">
              Infrastructure for vibe-coded games. Multiplayer, deployment,
              hosting — all through skills your LLM already knows.
            </p>
            <div className="flex justify-center">
              <div className="bg-secondary/50 rounded-lg border border-white/5 px-5 py-3 text-sm">
                <span className="text-muted-foreground select-none">$ </span>
                <span className="text-foreground">
                  npx vibedgames skills .
                </span>
              </div>
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2, duration: 0.8 }}
            className="text-muted-foreground/30 mt-16 text-xs"
          >
            scroll to explore ↓
          </motion.div>
        </section>

        {/* Section: Install */}
        <AnimatedSection className="flex min-h-[70vh] items-center px-6 py-20">
          <div className="mx-auto grid max-w-4xl gap-10 sm:grid-cols-2 sm:items-center">
            <div>
              <div className="text-muted-foreground mb-2 text-[10px] uppercase tracking-widest">
                01 — Install
              </div>
              <h2 className="mb-3 text-xl font-light sm:text-2xl">
                Add skills to your project
              </h2>
              <p className="text-muted-foreground text-xs leading-relaxed">
                One command installs vibedgames skills into your project. Your
                LLM gets deploy, multiplayer, asset generation, and more — ready
                to use in any conversation.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-lg border border-white/5 p-5">
              <div className="space-y-3 text-xs">
                <div className="text-muted-foreground">
                  <span className="text-muted-foreground/50">$</span> npx
                  vibedgames skills .
                </div>
                <div className="border-t border-white/5 pt-3">
                  <TypingLine
                    delay={0.3}
                    text="Downloading vibedgames skills..."
                  />
                  <TypingLine delay={0.6} text="Installing 15 skills..." />
                  <div className="mt-2">
                    <TypingLine
                      delay={0.9}
                      text="✓ Skills installed to .claude/skills/"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Section: Describe */}
        <AnimatedSection className="flex min-h-[70vh] items-center px-6 py-20">
          <div className="mx-auto grid max-w-4xl gap-10 sm:grid-cols-2 sm:items-center">
            <div className="sm:order-2">
              <div className="text-muted-foreground mb-2 text-[10px] uppercase tracking-widest">
                02 — Describe
              </div>
              <h2 className="mb-3 text-xl font-light sm:text-2xl">
                Say what you want
              </h2>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Describe your game to any LLM. A platformer, a puzzle game, a
                space shooter — whatever you're vibing. It writes the code,
                picks the right framework, and runs it locally.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-lg border border-white/5 p-5 sm:order-1">
              <div className="space-y-3 text-xs">
                <div className="text-muted-foreground">
                  <span className="text-muted-foreground/50">you &gt;</span>{" "}
                  build me an asteroid mining game with physics
                </div>
                <div className="border-t border-white/5 pt-3">
                  <TypingLine
                    delay={0.3}
                    text="Setting up project with Matter.js physics..."
                  />
                  <TypingLine
                    delay={0.6}
                    text="Creating asteroid field generator..."
                  />
                  <TypingLine
                    delay={0.9}
                    text="Adding mining beam mechanics..."
                  />
                  <TypingLine
                    delay={1.2}
                    text="Implementing resource collection UI..."
                  />
                  <div className="mt-2">
                    <TypingLine
                      delay={1.5}
                      text="✓ Game running at localhost:5173"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Section: Multiplayer */}
        <AnimatedSection className="flex min-h-[70vh] items-center px-6 py-20">
          <div className="mx-auto grid max-w-4xl gap-10 sm:grid-cols-2 sm:items-center">
            <div>
              <div className="text-muted-foreground mb-2 text-[10px] uppercase tracking-widest">
                03 — Multiplayer
              </div>
              <h2 className="mb-3 text-xl font-light sm:text-2xl">
                One sentence, real-time
              </h2>
              <p className="text-muted-foreground text-xs leading-relaxed">
                "Make it multiplayer." Your LLM installs our SDK, wires up state
                sync, and handles host authority. No servers to configure, no
                networking code to write.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-lg border border-white/5 p-5">
              <div className="space-y-3 text-xs">
                <div className="text-muted-foreground">
                  <span className="text-muted-foreground/50">you &gt;</span>{" "}
                  add multiplayer so friends can mine together
                </div>
                <div className="border-t border-white/5 pt-3">
                  <TypingLine
                    delay={0.3}
                    text="Installing @vibedgames/multiplayer..."
                  />
                  <TypingLine
                    delay={0.6}
                    text="Syncing asteroid positions across players..."
                  />
                  <TypingLine
                    delay={0.9}
                    text="Adding shared resource pool..."
                  />
                  <div className="mt-2">
                    <TypingLine
                      delay={1.2}
                      text="✓ Co-op multiplayer ready"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Section: Deploy */}
        <AnimatedSection className="flex min-h-[70vh] items-center px-6 py-20">
          <div className="mx-auto grid max-w-4xl gap-10 sm:grid-cols-2 sm:items-center">
            <div className="sm:order-2">
              <div className="text-muted-foreground mb-2 text-[10px] uppercase tracking-widest">
                04 — Deploy
              </div>
              <h2 className="mb-3 text-xl font-light sm:text-2xl">
                Live in seconds
              </h2>
              <p className="text-muted-foreground text-xs leading-relaxed">
                One slash command. Your game is built for production, uploaded to
                our global CDN, and live at your-game.vibedgames.com. Share the
                link and anyone can play.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-lg border border-white/5 p-5 sm:order-1">
              <div className="space-y-3 text-xs">
                <div className="text-muted-foreground">
                  <span className="text-muted-foreground/50">you &gt;</span>{" "}
                  /deploy
                </div>
                <div className="border-t border-white/5 pt-3">
                  <TypingLine
                    delay={0.3}
                    text="Building for production..."
                  />
                  <TypingLine
                    delay={0.6}
                    text="Optimizing assets (143kb)..."
                  />
                  <TypingLine
                    delay={0.9}
                    text="Uploading to vibedgames CDN..."
                  />
                  <div className="mt-2">
                    <TypingLine
                      delay={1.2}
                      text="✓ Live at asteroid-miner.vibedgames.com"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Section: Play */}
        <AnimatedSection className="flex min-h-[70vh] items-center px-6 py-20">
          <div className="mx-auto grid max-w-4xl gap-10 sm:grid-cols-2 sm:items-center">
            <div>
              <div className="text-muted-foreground mb-2 text-[10px] uppercase tracking-widest">
                05 — Play
              </div>
              <h2 className="mb-3 text-xl font-light sm:text-2xl">
                Players find your game
              </h2>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Your game appears on vibedgames.com where players can discover,
                play, and share it. Global CDN for instant loads. Zero
                maintenance.
              </p>
            </div>
            <div className="bg-secondary/50 rounded-lg border border-white/5 p-5">
              <div className="space-y-3">
                {[
                  {
                    name: "Asteroid Miner",
                    slug: "asteroid-miner",
                    players: "4 playing",
                    icon: "⛏",
                  },
                  {
                    name: "Space Shooter",
                    slug: "space-shooter",
                    players: "2 playing",
                    icon: "🚀",
                  },
                  {
                    name: "Pixel Racer",
                    slug: "pixel-racer",
                    players: "6 playing",
                    icon: "🏎",
                  },
                ].map((game) => (
                  <div
                    key={game.slug}
                    className="flex items-center gap-3 rounded border border-white/5 bg-white/[0.02] p-3 text-xs"
                  >
                    <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm">
                      {game.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate font-medium">
                        {game.name}
                      </div>
                      <div className="text-muted-foreground/50">
                        {game.slug}.vibedgames.com
                      </div>
                    </div>
                    <div className="text-muted-foreground/50 shrink-0">
                      {game.players}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* CTA */}
        <section className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-20 text-center">
          <AnimatedSection className="flex flex-col items-center gap-6">
            <h2 className="text-2xl font-light tracking-tight sm:text-3xl">
              Ready to ship your game?
            </h2>
            <div className="bg-secondary/50 rounded-lg border border-white/5 px-5 py-3 text-sm">
              <span className="text-muted-foreground select-none">$ </span>
              <span className="text-foreground">npx vibedgames skills .</span>
            </div>
          </AnimatedSection>
        </section>
      </main>
    </div>
  );
}
