import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";

import { Button } from "@repo/ui/components/button";

import { GitHubLink, RegisterLink } from "@/components/auth/register-link";
import { ClaudeIcon, CodexIcon, CursorIcon } from "@/components/ui/brand-icons";
import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { chromatic, RollingLabel, RollingText } from "@/components/ui/rolling-text";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

const INSTALL_PROMPT = "Read https://vibedgames.com/install then help me build my game";

function InstallPrompt() {
  const { copied, copy } = useCopyToClipboard();

  return (
    <header className="absolute left-[25px] bottom-8 sm:bottom-16 z-10 flex flex-col items-start">
      <FadeInBlur className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <span>Prompt to install</span>
        <span className="flex items-center gap-1.5">
          <ClaudeIcon className="size-3.5" />
          <CodexIcon className="size-3.5" />
          <CursorIcon className="size-3.5" />
        </span>
      </FadeInBlur>
      <FadeInBlur>
        <Button onClick={() => copy(INSTALL_PROMPT)} aria-label="Copy prompt to install">
          <RollingLabel words={["Copy Prompt", "Paste in your agent"]} index={copied ? 1 : 0} />
          <motion.span
            key={copied ? "check" : "copy"}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className="flex items-center justify-center"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </motion.span>
        </Button>
      </FadeInBlur>
    </header>
  );
}

export const Route = createFileRoute("/_site/build")({
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
    title: "Just Chat",
    tag: "use vibedgames.com to help me build my game",
    desc: "Build, tweak, ship, all from prompting.",
    color: "#F59279",
    zIndex: 2,
  },
  {
    index: "02",
    title: "Build studio grade games",
    tag: "make a pixel art top down slasher",
    desc: "Sprites, samples, soundtracks. All generated.",
    color: "#F9B060",
    zIndex: 5,
  },
  {
    index: "03",
    title: "Big features, simple prompts",
    tag: "add real-time multiplayer",
    desc: "Multiplayer, physics, camera tracking. Just ask.",
    color: "#F5D84A",
    zIndex: 1,
  },
  {
    index: "04",
    title: "Live in seconds",
    tag: "deploy my game",
    desc: "Just say deploy and share your game with the world.",
    color: "#80D487",
    zIndex: 4,
  },
  {
    index: "05",
    title: "Learn as you build",
    tag: "/teach-me how to build a platformer",
    desc: "A built-in tutor. Learn gamedev by shipping real games.",
    color: "#73B7E5",
    zIndex: 3,
  },
];

// The card pastels above, saturated a touch so the chromatic flash still reads
// once the letters settle into the muted heading color.
const ROLL_PALETTE = [
  "hsl(12 90% 66%)", // #F59279
  "hsl(31 95% 62%)", // #F9B060
  "hsl(50 94% 57%)", // #F5D84A
  "hsl(125 55% 60%)", // #80D487
  "hsl(204 75% 60%)", // #73B7E5
];

function randomOffset() {
  return {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 10,
    rotate: (Math.random() - 0.5) * 20,
  };
}

const ZERO_OFFSET = { x: 0, y: 0, rotate: 0 };

function CardContent({ card, onActivate }: { card: Offering; onActivate?: () => void }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => {
        copy(card.tag);
        onActivate?.();
      }}
      aria-label={`Copy prompt: ${card.tag}`}
      className="group flex h-full w-full cursor-pointer flex-col justify-between rounded-[inherit] text-left outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em]">
        <span>{card.index}</span>
      </div>
      <p className="text-xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-2xl">
        {card.title}. <span className="opacity-60">{card.desc}</span>
      </p>
      <div className="-mx-5 -mb-5 flex w-[calc(100%+2.5rem)] items-start gap-1.5 border-t border-dashed border-black/40 px-5 pt-4 pb-5 font-mono text-[11px] leading-snug">
        <span className="flex h-[1lh] shrink-0 items-center">
          <ChevronRightIcon className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
        </span>
        <RollingLabel
          words={[card.tag, "Paste in your agent"]}
          index={copied ? 1 : 0}
          fluid={false}
          className="flex-1 opacity-60 transition-opacity group-hover:opacity-100"
        />
        <motion.span
          key={copied ? "check" : "copy"}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
          className="flex h-[1lh] shrink-0 items-center justify-center opacity-60 transition-opacity group-hover:opacity-100"
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </motion.span>
      </div>
    </button>
  );
}

const SPRING = {
  type: "spring" as const,
  stiffness: 110,
  damping: 14,
  mass: 1,
};

const MOBILE_POSITIONS = [
  { top: "0%", left: "2%", rotate: -7 },
  { top: "14%", left: "42%", rotate: 5 },
  { top: "28%", left: "8%", rotate: 8 },
  { top: "42%", left: "40%", rotate: -4 },
  { top: "56%", left: "0%", rotate: -3 },
] as const;

function OfferingsDeckDesktop() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [offsets, setOffsets] = useState(() => OFFERINGS.map(() => ZERO_OFFSET));

  useEffect(() => {
    setOffsets(OFFERINGS.map(randomOffset));
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(OFFERINGS.length - 1, Math.max(0, Math.floor(pct * OFFERINGS.length)));
    if (idx === activeIdx) return;
    if (activeIdx !== null) {
      setOffsets((prev) => prev.map((o, i) => (i === activeIdx ? randomOffset() : o)));
    }
    setActiveIdx(idx);
  };

  const handleMouseLeave = () => {
    if (activeIdx !== null) {
      setOffsets((prev) => prev.map((o, i) => (i === activeIdx ? randomOffset() : o)));
    }
    setActiveIdx(null);
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="hidden items-center justify-center sm:mt-[12vh] sm:flex"
    >
      {OFFERINGS.map((card, i) => {
        const off = offsets[i] ?? ZERO_OFFSET;
        const isActive = activeIdx === i;

        const cardTarget = isActive
          ? { x: "0%", y: "0%", rotate: 0, scale: 1.1 }
          : {
              x: `${off.x}%`,
              y: `${off.y}%`,
              rotate: off.rotate,
              scale: 1,
            };

        const innerX = activeIdx === null || activeIdx === i ? "0%" : `${80 / (i - activeIdx)}%`;

        return (
          <motion.div
            key={card.index}
            animate={cardTarget}
            transition={SPRING}
            style={{ zIndex: card.zIndex }}
            className="relative aspect-[0.8] w-64 shrink-0 rounded-[0.6em] first:ml-0 [&:not(:first-child)]:-ml-20"
          >
            <motion.div
              animate={{ x: innerX }}
              transition={SPRING}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-[0.6em] p-5 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} onActivate={() => setActiveIdx(i)} />
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}

function OfferingsDeckMobile() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  return (
    <div
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) setActiveIdx(null);
      }}
      className="relative mx-auto mt-4 h-[85vh] w-full max-w-sm px-4 sm:hidden"
    >
      {OFFERINGS.map((card, i) => {
        const p = MOBILE_POSITIONS[i] ?? { top: "0%", left: "0%", rotate: 0 };
        const isActive = activeIdx === i;
        const activeP = activeIdx !== null ? MOBILE_POSITIONS[activeIdx] : null;

        let innerX = "0%";
        let innerY = "0%";
        if (activeP && !isActive) {
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

        const transition = {
          delay: isInView && activeIdx === null ? 0.05 * i : 0,
          type: "spring" as const,
          stiffness: 90,
          damping: 14,
        };

        return (
          <motion.div
            key={card.index}
            initial={{ opacity: 0, y: 20, rotate: 0, scale: 0.9 }}
            animate={cardTarget}
            transition={transition}
            style={{
              top: p.top,
              left: p.left,
              zIndex: isActive ? 50 : card.zIndex,
              transformOrigin: "center center",
            }}
            className="absolute aspect-[0.8] w-[55%] rounded-xl"
          >
            <motion.div
              animate={{ x: innerX, y: innerY }}
              transition={SPRING}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-xl p-4 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} onActivate={() => setActiveIdx(i)} />
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}

function OfferingsDeck() {
  return (
    <section className="relative flex flex-col items-center justify-center overflow-x-clip pb-20 sm:pb-40 sm:h-dvh sm:overflow-hidden sm:pb-0">
      <FadeInBlur className="self-start px-6 pt-8 sm:absolute sm:left-[25px] sm:top-[25px] sm:z-10 sm:max-w-4xl sm:px-0 sm:pt-0">
        <h1 className="text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
          A game studio
          <br />
          <span className="text-muted-foreground">
            for your{" "}
            <RollingText
              words={["claude", "codex", "cursor", "agent"]}
              color={chromatic({ palette: ROLL_PALETTE })}
            />
          </span>
        </h1>
      </FadeInBlur>

      <OfferingsDeckDesktop />
      <OfferingsDeckMobile />
    </section>
  );
}

function BuildPage() {
  return (
    <main>
      <RegisterLink />
      <OfferingsDeck />
      <InstallPrompt />
      <GitHubLink />
    </main>
  );
}
