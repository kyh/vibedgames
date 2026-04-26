import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/components/input-group";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";

import {
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
} from "@/components/ui/brand-icons";
import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

const INSTALL_PROMPT = "Use vibedgames to help me build my game";

function InstallPrompt() {
  const { copied, copy } = useCopyToClipboard();

  return (
    <header className="fixed inset-x-0 bottom-16 z-10 flex max-h-full flex-col px-4 md:right-auto md:w-96">
      <FadeInBlur className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <span>Just tell your llm</span>
        <span className="flex items-center gap-1.5">
          <ClaudeIcon className="size-3.5" />
          <CodexIcon className="size-3.5" />
          <CursorIcon className="size-3.5" />
        </span>
      </FadeInBlur>
      <div className="relative pb-4">
        <motion.div className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm" />
        <FadeInBlur>
          <InputGroup className="text-foreground border-none bg-transparent text-sm">
            <InputGroupInput
              type="text"
              className="py-2.5 font-mono text-xs md:text-xs"
              onClick={(event) => event.currentTarget.select()}
              value={INSTALL_PROMPT}
              readOnly
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                onClick={() => copy(INSTALL_PROMPT)}
                size="icon-xs"
                aria-label="Copy install prompt"
              >
                <motion.span
                  key={copied ? "check" : "copy"}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className="flex items-center justify-center"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </motion.span>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </FadeInBlur>
      </div>
    </header>
  );
}

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
    title: "Just Chat",
    tag: INSTALL_PROMPT,
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
    title: "Learn together",
    tag: "join the discord",
    desc: "A Discord of vibe game devs learning side by side.",
    color: "#73B7E5",
    zIndex: 3,
  },
];

function randomOffset() {
  return {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 10,
    rotate: (Math.random() - 0.5) * 20,
  };
}

const ZERO_OFFSET = { x: 0, y: 0, rotate: 0 };

function CardContent({ card }: { card: Offering }) {
  const { copied, copy } = useCopyToClipboard();

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy(card.tag);
  };

  return (
    <div className="flex h-full w-full flex-col justify-between">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em]">
        <span>{card.index}</span>
      </div>
      <p className="text-xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-2xl">
        {card.title}.{" "}
        <span className="opacity-60">{card.desc}</span>
      </p>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy prompt: ${card.tag}`}
        className="group -mx-5 -mb-5 flex w-[calc(100%+2.5rem)] cursor-pointer items-start gap-1.5 border-t border-dashed border-black/40 px-5 pt-4 pb-5 text-left font-mono text-[11px] leading-snug"
      >
        <ChevronRightIcon className="size-3 shrink-0 translate-y-px opacity-60 transition-opacity group-hover:opacity-100" />
        <span className="flex-1 opacity-60 transition-opacity group-hover:opacity-100">
          {card.tag}
        </span>
        <motion.span
          key={copied ? "check" : "copy"}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
          className="flex shrink-0 translate-y-px items-center justify-center opacity-60 transition-opacity group-hover:opacity-100"
        >
          {copied ? (
            <CheckIcon className="size-3" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </motion.span>
      </button>
    </div>
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

const cardKeyHandler = (toggle: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle();
  }
};

function OfferingsDeckDesktop() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [offsets, setOffsets] = useState(() =>
    OFFERINGS.map(() => ZERO_OFFSET),
  );

  useEffect(() => {
    setOffsets(OFFERINGS.map(randomOffset));
  }, []);

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

  const toggle = (i: number) =>
    setActiveIdx((curr) => (curr === i ? null : i));

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="hidden items-center justify-center sm:mt-[4vh] sm:flex"
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

        const innerX =
          activeIdx === null || activeIdx === i
            ? "0%"
            : `${80 / (i - activeIdx)}%`;

        return (
          <motion.div
            key={card.index}
            role="button"
            tabIndex={0}
            animate={cardTarget}
            transition={SPRING}
            aria-pressed={isActive}
            aria-label={`${card.title}: ${card.desc}`}
            onClick={() => toggle(i)}
            onKeyDown={cardKeyHandler(() => toggle(i))}
            style={{ zIndex: card.zIndex }}
            className="relative aspect-[0.8] w-64 shrink-0 cursor-pointer rounded-[0.6em] text-left outline-none first:ml-0 focus-visible:ring-2 focus-visible:ring-white [&:not(:first-child)]:-ml-20"
          >
            <motion.div
              animate={{ x: innerX }}
              transition={SPRING}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-[0.6em] p-5 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} />
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

  const toggle = (i: number) =>
    setActiveIdx((curr) => (curr === i ? null : i));

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
        const activeP =
          activeIdx !== null ? MOBILE_POSITIONS[activeIdx] : null;

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
            role="button"
            tabIndex={0}
            initial={{ opacity: 0, y: 20, rotate: 0, scale: 0.9 }}
            animate={cardTarget}
            transition={transition}
            aria-pressed={isActive}
            aria-label={`${card.title}: ${card.desc}`}
            onClick={() => toggle(i)}
            onKeyDown={cardKeyHandler(() => toggle(i))}
            style={{
              top: p.top,
              left: p.left,
              zIndex: isActive ? 50 : card.zIndex,
              transformOrigin: "center center",
            }}
            className="absolute aspect-[0.8] w-[55%] cursor-pointer rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <motion.div
              animate={{ x: innerX, y: innerY }}
              transition={SPRING}
              style={{ backgroundColor: card.color }}
              className="h-full w-full rounded-xl p-4 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
            >
              <CardContent card={card} />
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}

function OfferingsDeck() {
  return (
    <section className="relative flex flex-col items-center justify-center overflow-x-clip pb-40 sm:h-dvh sm:overflow-hidden sm:pb-0">
      <FadeInBlur className="self-start px-6 pt-8 sm:absolute sm:left-[25px] sm:top-[25px] sm:z-10 sm:max-w-4xl sm:px-0 sm:pt-0">
        <h1 className="text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
          You bring the ideas.
          <br />
          <span className="text-muted-foreground">
            We bring the game studio.
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
      <OfferingsDeck />
      <InstallPrompt />
    </main>
  );
}
