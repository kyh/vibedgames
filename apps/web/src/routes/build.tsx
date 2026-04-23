import { useRef, useState } from "react";
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

type Offering = {
  index: string;
  title: string;
  tag: string;
  desc: string;
  color: string;
  zIndex: number;
};

const OFFERINGS: Offering[] = [
  {
    index: "01",
    title: "Skills",
    tag: "npx vibedgames skills",
    desc: "The toolkit your LLM already knows.",
    color: "#F14A3A",
    zIndex: 3,
  },
  {
    index: "02",
    title: "CLI",
    tag: "vg deploy",
    desc: "One command. Device-code auth. Ship.",
    color: "#FB7350",
    zIndex: 2,
  },
  {
    index: "03",
    title: "Multiplayer",
    tag: "@vibedgames/multiplayer",
    desc: "Real-time sync. Host-authoritative.",
    color: "#F79C42",
    zIndex: 7,
  },
  {
    index: "04",
    title: "Hosting",
    tag: "R2 · global CDN",
    desc: "Immutable deploys. 1yr cache. No cold starts.",
    color: "#FFDF40",
    zIndex: 1,
  },
  {
    index: "05",
    title: "Subdomain",
    tag: "{slug}.vibedgames.com",
    desc: "Every game gets a link. Sandboxed.",
    color: "#DEDA8D",
    zIndex: 4,
  },
  {
    index: "06",
    title: "Assets",
    tag: "v0 · sprites + audio",
    desc: "Skip the placeholder rectangles.",
    color: "#71CFA3",
    zIndex: 5,
  },
  {
    index: "07",
    title: "Discovery",
    tag: "vibedgames.com",
    desc: "Players find you on the hub.",
    color: "#C4EF7A",
    zIndex: 8,
  },
  {
    index: "08",
    title: "Auth",
    tag: "better-auth · device-code",
    desc: "Sessions locked to apex. Secure.",
    color: "#BCEFFF",
    zIndex: 6,
  },
];

function randomOffset() {
  return {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 10,
    rotate: (Math.random() - 0.5) * 20,
  };
}

function OfferingsDeck() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [offsets, setOffsets] = useState(() => OFFERINGS.map(randomOffset));

  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, margin: "-100px" });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(
      OFFERINGS.length - 1,
      Math.max(0, Math.floor(pct * OFFERINGS.length)),
    );
    if (idx === activeIdx) return;
    if (activeIdx !== null) {
      setOffsets((prev) =>
        prev.map((o, i) => (i === activeIdx ? randomOffset() : o)),
      );
    }
    setActiveIdx(idx);
  };

  const handleMouseLeave = () => {
    if (activeIdx !== null) {
      setOffsets((prev) =>
        prev.map((o, i) => (i === activeIdx ? randomOffset() : o)),
      );
    }
    setActiveIdx(null);
  };

  const spring = { type: "spring" as const, stiffness: 110, damping: 14, mass: 1 };

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-dvh flex-col justify-center py-24"
    >
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
        transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
        className="mb-12 px-6 sm:mb-16 sm:px-10"
      >
        <div className="text-muted-foreground mb-3 text-[10px] uppercase tracking-[0.25em]">
          What vibedgames ships
        </div>
        <h2 className="max-w-3xl text-3xl font-light leading-[0.95] tracking-tight sm:text-5xl md:text-6xl">
          Everything you need
          <br />
          <span className="text-muted-foreground">nothing you don't.</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-sm text-xs leading-relaxed">
          Hover across the deck — each card is one slice of the platform your
          LLM can reach for.
        </p>
      </motion.div>

      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="hidden h-[60vh] items-center justify-center px-4 sm:flex"
      >
        {OFFERINGS.map((card, i) => {
          const off = offsets[i] ?? { x: 0, y: 0, rotate: 0 };
          const isActive = activeIdx === i;

          const cardTarget = isActive
            ? { x: "0%", y: "0%", rotate: 0, scale: 1.1 }
            : {
                x: `${off.x}%`,
                y: `${off.y}%`,
                rotate: off.rotate,
                scale: 1,
              };

          const innerX =
            activeIdx === null || activeIdx === i
              ? "0%"
              : `${80 / (i - activeIdx)}%`;

          return (
            <motion.div
              key={card.index}
              animate={cardTarget}
              transition={spring}
              style={{ zIndex: card.zIndex }}
              className="relative aspect-[0.8] w-[20vw] shrink-0 first:ml-0 [&:not(:first-child)]:-ml-[10vw]"
            >
              <motion.div
                animate={{ x: innerX }}
                transition={spring}
                style={{ backgroundColor: card.color }}
                className="flex h-full w-full flex-col justify-between rounded-xl p-[1.25vw] text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
              >
                <div className="flex items-start justify-between font-mono text-[0.7vw] uppercase tracking-[0.2em]">
                  <span>{card.index}</span>
                  <span className="opacity-50">— vg</span>
                </div>
                <div>
                  <p className="font-mono text-[2.2vw] font-medium leading-[0.9] tracking-tight">
                    {card.title}.
                  </p>
                  <p className="mt-[0.6vw] font-mono text-[0.85vw] leading-snug opacity-70">
                    {card.desc}
                  </p>
                </div>
                <div className="border-t border-dashed border-black/40 pt-[0.8vw] font-mono text-[0.7vw] uppercase tracking-[0.18em]">
                  {card.tag}
                </div>
              </motion.div>
            </motion.div>
          );
        })}
      </div>

      {/* Mobile: stacked vertical list */}
      <div className="flex flex-col gap-3 px-6 sm:hidden">
        {OFFERINGS.map((card) => (
          <div
            key={card.index}
            style={{ backgroundColor: card.color }}
            className="rounded-xl p-5 text-black"
          >
            <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.15em]">
              <span>{card.index}</span>
              <span className="opacity-60">— vg</span>
            </div>
            <p className="font-mono text-xl font-medium leading-[0.95] tracking-tight">
              {card.title}.{" "}
              <span className="opacity-70">{card.desc}</span>
            </p>
            <div className="mt-4 border-t border-dashed border-black/40 pt-3 font-mono text-[10px] uppercase tracking-[0.15em]">
              {card.tag}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BuildPage() {
  return (
    <div className="relative min-h-dvh overflow-x-hidden overflow-y-auto">
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

        <OfferingsDeck />

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
