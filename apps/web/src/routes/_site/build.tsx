import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";

import { Button } from "@repo/ui/components/button";

import { GitHubLink, RegisterLink } from "@/components/auth/register-link";
import type { Offering } from "@/content/build";
import { buildDoc, OFFERINGS } from "@/content/build";
import { docHandler, docHead, varyHeaders } from "@/lib/doc-route";
import { ClaudeIcon, CodexIcon, CursorIcon } from "@/components/ui/brand-icons";
import { FadeInBlur } from "@/components/ui/fade-in-blur";
import { chromatic, RollingLabel, RollingText } from "@/components/ui/rolling-text";
import { INSTALL_PROMPT } from "@/lib/install-prompt";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

const InstallPrompt = () => {
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
            transition={{ damping: 20, stiffness: 400, type: "spring" }}
            className="flex items-center justify-center"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </motion.span>
        </Button>
      </FadeInBlur>
    </header>
  );
};

// The `OFFERINGS` card pastels, saturated a touch so the chromatic flash still
// reads once the letters settle into the muted heading color.
const ROLL_PALETTE = [
  // #F59279
  "hsl(12 90% 66%)",
  // #F9B060
  "hsl(31 95% 62%)",
  // #F5D84A
  "hsl(50 94% 57%)",
  // #80D487
  "hsl(125 55% 60%)",
  // #73B7E5
  "hsl(204 75% 60%)",
];

const randomOffset = () => ({
  rotate: (Math.random() - 0.5) * 20,
  x: (Math.random() - 0.5) * 10,
  y: (Math.random() - 0.5) * 10,
});

const ZERO_OFFSET = { rotate: 0, x: 0, y: 0 };

const CardContent = ({ card, onActivate }: { card: Offering; onActivate?: () => void }) => {
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
          transition={{ damping: 20, stiffness: 400, type: "spring" }}
          className="flex h-[1lh] shrink-0 items-center justify-center opacity-60 transition-opacity group-hover:opacity-100"
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </motion.span>
      </div>
    </button>
  );
};

const SPRING = {
  damping: 14,
  mass: 1,
  stiffness: 110,
  type: "spring" as const,
};

// oxlint-disable-next-line unicorn/prefer-number-coercion -- positions are CSS percentages like "12%"; Number() gives NaN
const pct = (length: string): number => Number.parseFloat(length);

const MOBILE_POSITIONS = [
  { left: "2%", rotate: -7, top: "0%" },
  { left: "42%", rotate: 5, top: "14%" },
  { left: "8%", rotate: 8, top: "28%" },
  { left: "40%", rotate: -4, top: "42%" },
  { left: "0%", rotate: -3, top: "56%" },
] as const;

const OfferingsDeckDesktop = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [offsets, setOffsets] = useState(() => OFFERINGS.map(() => ZERO_OFFSET));

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the scatter is random, so it can only be drawn after hydration; seeding it in state would mismatch the server render
    setOffsets(OFFERINGS.map(randomOffset));
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(OFFERINGS.length - 1, Math.max(0, Math.floor(ratio * OFFERINGS.length)));
    if (idx === activeIdx) {
      return;
    }
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
          ? { rotate: 0, scale: 1.1, x: "0%", y: "0%" }
          : {
              rotate: off.rotate,
              scale: 1,
              x: `${off.x}%`,
              y: `${off.y}%`,
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
};

const mobileCardTarget = (isInView: boolean, isActive: boolean, rotate: number) => {
  if (!isInView) {
    return { opacity: 0, rotate: 0, scale: 0.9, y: 20 };
  }
  return isActive
    ? { opacity: 1, rotate: 0, scale: 1.15, y: 0 }
    : { opacity: 1, rotate, scale: 1, y: 0 };
};

const OfferingsDeckMobile = () => {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { margin: "-100px", once: true });
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop dismissal for a decorative deck; every card is a real button, and a container that took focus would only add a dead tab stop
    <div
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setActiveIdx(null);
        }
      }}
      className="relative mx-auto mt-4 h-[85vh] w-full max-w-sm px-4 sm:hidden"
    >
      {OFFERINGS.map((card, i) => {
        const p = MOBILE_POSITIONS[i] ?? { left: "0%", rotate: 0, top: "0%" };
        const isActive = activeIdx === i;
        const activeP = activeIdx === null ? null : MOBILE_POSITIONS[activeIdx];

        let innerX = "0%";
        let innerY = "0%";
        if (activeP && !isActive) {
          const dx = pct(p.left) - pct(activeP.left);
          const dy = pct(p.top) - pct(activeP.top);
          innerX = `${Math.sign(dx) * 40}%`;
          innerY = `${Math.sign(dy) * 40}%`;
        }

        const cardTarget = mobileCardTarget(isInView, isActive, p.rotate);

        const transition = {
          damping: 14,
          delay: isInView && activeIdx === null ? 0.05 * i : 0,
          stiffness: 90,
          type: "spring" as const,
        };

        return (
          <motion.div
            key={card.index}
            initial={{ opacity: 0, rotate: 0, scale: 0.9, y: 20 }}
            animate={cardTarget}
            transition={transition}
            style={{
              left: p.left,
              top: p.top,
              transformOrigin: "center center",
              zIndex: isActive ? 50 : card.zIndex,
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
};

const OfferingsDeck = () => (
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

const BuildPage = () => (
  <main>
    <RegisterLink />
    <OfferingsDeck />
    <InstallPrompt />
    <GitHubLink />
  </main>
);

export const Route = createFileRoute("/_site/build")({
  component: BuildPage,
  head: () => docHead(buildDoc),
  headers: varyHeaders(),
  server: { handlers: { GET: docHandler(buildDoc) } },
});
