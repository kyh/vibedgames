import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";

import { WaitlistForm } from "@/components/game/waitlist-form";

export const Route = createFileRoute("/build")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: BuildPage,
});

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
    title: "CLI",
    tag: "vg deploy",
    desc: "One command. Device-code auth. Ship.",
    color: "#F59279",
    zIndex: 2,
  },
  {
    index: "02",
    title: "Multiplayer",
    tag: "@vibedgames/multiplayer",
    desc: "Real-time sync. Host-authoritative.",
    color: "#F9B060",
    zIndex: 5,
  },
  {
    index: "03",
    title: "Hosting",
    tag: "R2 · global CDN",
    desc: "Immutable deploys. 1yr cache. No cold starts.",
    color: "#F5D84A",
    zIndex: 1,
  },
  {
    index: "04",
    title: "Subdomain",
    tag: "{slug}.vibedgames.com",
    desc: "Every game gets a link. Sandboxed.",
    color: "#80D487",
    zIndex: 4,
  },
  {
    index: "05",
    title: "Discovery",
    tag: "vibedgames.com",
    desc: "Players find you on the hub.",
    color: "#73B7E5",
    zIndex: 3,
  },
  {
    index: "06",
    title: "Waitlist",
    tag: "",
    desc: "Private beta. Get in.",
    color: "#B982D4",
    zIndex: 6,
  },
];

const WAITLIST_IDX = OFFERINGS.length - 1;

function randomOffset() {
  return {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 10,
    rotate: (Math.random() - 0.5) * 20,
  };
}

const ZERO_OFFSET = { x: 0, y: 0, rotate: 0 };

function CardContent({ card, isWaitlist }: { card: Offering; isWaitlist: boolean }) {
  return (
    <div className="flex h-full w-full flex-col justify-between">
      <div className="flex items-start justify-between font-mono text-[9px] uppercase tracking-[0.2em] sm:text-[0.7vw]">
        <span>{card.index}</span>
        <span className="opacity-50">— vg</span>
      </div>
      <p className="text-xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-[1.9vw]">
        {card.title}.{" "}
        <span className="opacity-60">{card.desc}</span>
      </p>
      {isWaitlist ? (
        <div className="border-t border-dashed border-black/40 pt-2 sm:pt-[1vw]">
          <WaitlistForm />
        </div>
      ) : (
        <div className="border-t border-dashed border-black/40 pt-2 font-mono text-[9px] uppercase tracking-[0.18em] sm:pt-[1vw] sm:text-[0.7vw]">
          {card.tag}
        </div>
      )}
    </div>
  );
}

function OfferingsDeck() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [offsets, setOffsets] = useState(() =>
    OFFERINGS.map(() => ZERO_OFFSET),
  );

  useEffect(() => {
    setOffsets(OFFERINGS.map(randomOffset));
  }, []);

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

  const toggle = (i: number) =>
    setActiveIdx((curr) => (curr === i ? null : i));

  return (
    <section
      ref={sectionRef}
      className="relative flex flex-col items-center justify-center overflow-x-hidden sm:h-dvh sm:overflow-hidden"
    >
      <div className="self-start px-6 pt-8 sm:absolute sm:left-[25px] sm:top-[25px] sm:z-10 sm:max-w-[70vw] sm:px-0 sm:pt-0">
        <h1 className="text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-[4vw]">
          You bring the game.
          <br />
          <span className="text-muted-foreground">
            We bring the internet.
          </span>
        </h1>
        <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 font-mono text-xs sm:mt-[1.5vw]">
          <span className="text-muted-foreground select-none">$</span>
          <span>npx vibedgames skills</span>
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="hidden items-center justify-center sm:mt-[20vh] sm:flex"
      >
        {OFFERINGS.map((card, i) => {
          const off = offsets[i] ?? { x: 0, y: 0, rotate: 0 };
          const isActive = activeIdx === i;
          const isWaitlist = i === WAITLIST_IDX;

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

          const wrapperClass =
            "relative aspect-[0.8] w-[20vw] shrink-0 appearance-none rounded-[0.6em] border-0 bg-transparent p-0 text-left outline-none first:ml-0 focus-visible:ring-2 focus-visible:ring-white [&:not(:first-child)]:-ml-[10vw]";
          const inner = (
            <motion.div
              animate={{ x: innerX }}
              transition={spring}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-[0.6em] p-[1.25vw] text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} isWaitlist={isWaitlist} />
            </motion.div>
          );

          if (isWaitlist) {
            return (
              <motion.div
                key={card.index}
                animate={cardTarget}
                transition={spring}
                style={{ zIndex: card.zIndex }}
                className={wrapperClass}
              >
                {inner}
              </motion.div>
            );
          }

          return (
            <motion.button
              key={card.index}
              type="button"
              animate={cardTarget}
              transition={spring}
              aria-pressed={isActive}
              aria-label={`${card.title}: ${card.desc}`}
              onClick={() => toggle(i)}
              style={{ zIndex: card.zIndex }}
              className={wrapperClass}
            >
              {inner}
            </motion.button>
          );
        })}
      </div>

      {/* Mobile: collage layout, tap or hover to activate */}
      <div
        onMouseLeave={() => setActiveIdx(null)}
        className="relative mx-auto mt-8 h-[120vh] w-full max-w-sm px-4 sm:hidden"
      >
        {OFFERINGS.map((card, i) => {
          const p = MOBILE_POSITIONS[i] ?? {
            top: "0%",
            left: "0%",
            rotate: 0,
          };
          const isActive = activeIdx === i;
          const isWaitlist = i === WAITLIST_IDX;
          const hasActive = activeIdx !== null;
          const activeP =
            activeIdx !== null ? MOBILE_POSITIONS[activeIdx] : null;

          let innerX = "0%";
          let innerY = "0%";
          if (hasActive && !isActive && activeP) {
            const dx = parseFloat(p.left) - parseFloat(activeP.left);
            const dy = parseFloat(p.top) - parseFloat(activeP.top);
            innerX = `${Math.sign(dx) * 40}%`;
            innerY = `${Math.sign(dy) * 40}%`;
          }

          const cardTarget = !isInView
            ? { opacity: 0, y: 20, rotate: 0, scale: 0.9 }
            : isActive
              ? { opacity: 1, y: 0, rotate: 0, scale: 1.15 }
              : { opacity: 1, y: 0, rotate: p.rotate, scale: 1 };

          const wrapperStyle = {
            top: p.top,
            left: p.left,
            zIndex: isActive ? 50 : card.zIndex,
            transformOrigin: "center center",
          } as const;
          const wrapperClass =
            "absolute aspect-[0.8] w-[55%] appearance-none rounded-xl border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-white";
          const transition = {
            delay: isInView && activeIdx === null ? 0.05 * i : 0,
            type: "spring" as const,
            stiffness: 90,
            damping: 14,
          };
          const inner = (
            <motion.div
              animate={{ x: innerX, y: innerY }}
              transition={spring}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-xl p-4 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} isWaitlist={isWaitlist} />
            </motion.div>
          );

          if (isWaitlist) {
            return (
              <motion.div
                key={card.index}
                initial={{ opacity: 0, y: 20, rotate: 0, scale: 0.9 }}
                animate={cardTarget}
                transition={transition}
                onMouseEnter={() => setActiveIdx(i)}
                style={wrapperStyle}
                className={wrapperClass}
              >
                {inner}
              </motion.div>
            );
          }

          return (
            <motion.button
              key={card.index}
              type="button"
              initial={{ opacity: 0, y: 20, rotate: 0, scale: 0.9 }}
              animate={cardTarget}
              transition={transition}
              aria-pressed={isActive}
              aria-label={`${card.title}: ${card.desc}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => toggle(i)}
              style={wrapperStyle}
              className={wrapperClass}
            >
              {inner}
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

const MOBILE_POSITIONS = [
  { top: "0%", left: "2%", rotate: -7 },
  { top: "16%", left: "42%", rotate: 5 },
  { top: "33%", left: "8%", rotate: 8 },
  { top: "50%", left: "40%", rotate: -4 },
  { top: "66%", left: "0%", rotate: -3 },
  { top: "82%", left: "38%", rotate: 9 },
] as const;

function BuildPage() {
  return (
    <main>
      <OfferingsDeck />
    </main>
  );
}
