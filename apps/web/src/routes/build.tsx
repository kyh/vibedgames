import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useInView } from "motion/react";
import { toast } from "@repo/ui/components/sonner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/ui/components/input-group";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";

const INSTALL_PROMPT = "Use vibedgames to help me build my game";

function InstallPrompt() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(INSTALL_PROMPT)
      .then(() => {
        setCopied(true);
        toast.success("Copied. Paste it into Claude, Cursor, or Codex.");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.error("Failed to copy."));
  };

  return (
    <header className="fixed inset-x-0 bottom-16 z-10 flex max-h-full flex-col px-4 md:right-auto md:w-96">
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        <span>Just tell your llm</span>
        <span className="flex items-center gap-1.5">
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="size-3.5"
            aria-label="Claude"
          >
            <title>Claude</title>
            <path d="m4.714 15.956 4.718-2.648.079-.23-.08-.128h-.23l-.79-.048-2.695-.073-2.337-.097-2.265-.122-.57-.121-.535-.704.055-.353.48-.321.685.06 1.518.104 2.277.157 1.651.098 2.447.255h.389l.054-.158-.133-.097-.103-.098-2.356-1.596-2.55-1.688-1.336-.972-.722-.491L2 6.223l-.158-1.008.655-.722.88.06.225.061.893.686 1.906 1.476 2.49 1.833.364.304.146-.104.018-.072-.164-.274-1.354-2.446-1.445-2.49-.644-1.032-.17-.619a2.972 2.972 0 0 1-.103-.729L6.287.133 6.7 0l.995.134.42.364.619 1.415L9.735 4.14l1.555 3.03.455.898.243.832.09.255h.159V9.01l.127-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.558 2.903-.365 1.942h.213l.243-.242.983-1.306 1.652-2.064.728-.82.85-.904.547-.431h1.032l.759 1.129-.34 1.166-1.063 1.347-.88 1.142-1.263 1.7-.79 1.36.074.11.188-.02 2.853-.606 1.542-.28 1.84-.315.832.388.09.395-.327.807-1.967.486-2.307.462-3.436.813-.043.03.049.061 1.548.146.662.036h1.62l3.018.225.79.522.473.638-.08.485-1.213.62-1.64-.389-3.825-.91-1.31-.329h-.183v.11l1.093 1.068 2.003 1.81 2.508 2.33.127.578-.321.455-.34-.049-2.204-1.657-.85-.747-1.925-1.62h-.127v.17l.443.649 2.343 3.521.122 1.08-.17.353-.607.213-.668-.122-1.372-1.924-1.415-2.168-1.141-1.943-.14.08-.674 7.254-.316.37-.728.28-.607-.461-.322-.747.322-1.476.388-1.924.316-1.53.285-1.9.17-.632-.012-.042-.14.018-1.432 1.967-2.18 2.945-1.724 1.845-.413.164-.716-.37.066-.662.401-.589 2.386-3.036 1.439-1.882.929-1.086-.006-.158h-.055L4.138 18.56l-1.13.146-.485-.456.06-.746.231-.243 1.907-1.312Z" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="size-3.5"
            aria-label="Codex"
          >
            <title>Codex</title>
            <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
            className="size-3.5"
            aria-label="Cursor"
          >
            <title>Cursor</title>
            <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
          </svg>
        </span>
      </div>
      <div className="relative pb-4">
        <motion.div className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm" />
        <motion.div
          transition={{ type: "spring", bounce: 0.1 }}
          initial={{ opacity: 0, filter: "blur(5px)" }}
          animate={{
            opacity: 1,
            filter: "blur(0px)",
            transition: { delay: 0.05 },
          }}
        >
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
                onClick={handleCopy}
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
        </motion.div>
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
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(card.tag)
      .then(() => {
        setCopied(true);
        toast.success("Copied. Paste it into Claude, Cursor, or Codex.");
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.error("Failed to copy."));
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
      className="relative flex flex-col items-center justify-center overflow-x-clip pb-40 sm:h-dvh sm:overflow-hidden sm:pb-0"
    >
      <div className="self-start px-6 pt-8 sm:absolute sm:left-[25px] sm:top-[25px] sm:z-10 sm:max-w-4xl sm:px-0 sm:pt-0">
        <h1 className="text-3xl font-medium leading-[0.9] -tracking-[0.03em] sm:text-5xl">
          You bring the ideas.
          <br />
          <span className="text-muted-foreground">
            We bring the game studio.
          </span>
        </h1>
      </div>

      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="hidden items-center justify-center sm:mt-[4vh] sm:flex"
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
              role="button"
              tabIndex={0}
              animate={cardTarget}
              transition={spring}
              aria-pressed={isActive}
              aria-label={`${card.title}: ${card.desc}`}
              onClick={() => toggle(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(i);
                }
              }}
              style={{ zIndex: card.zIndex }}
              className="relative aspect-[0.8] w-64 shrink-0 cursor-pointer rounded-[0.6em] text-left outline-none first:ml-0 focus-visible:ring-2 focus-visible:ring-white [&:not(:first-child)]:-ml-20"
            >
              <motion.div
                animate={{ x: innerX }}
                transition={spring}
                style={{ backgroundColor: card.color }}
                className="h-full w-full rounded-[0.6em] p-5 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
              >
                <CardContent card={card} />
              </motion.div>
            </motion.div>
          );
        })}
      </div>

      {/* Mobile: collage layout, tap to activate */}
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) setActiveIdx(null);
        }}
        className="relative mx-auto mt-4 h-[85vh] w-full max-w-sm px-4 sm:hidden"
      >
        {OFFERINGS.map((card, i) => {
          const p = MOBILE_POSITIONS[i] ?? {
            top: "0%",
            left: "0%",
            rotate: 0,
          };
          const isActive = activeIdx === i;
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
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(i);
                }
              }}
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
                transition={spring}
                style={{ backgroundColor: card.color }}
                className="h-full w-full rounded-xl p-4 text-black shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]"
              >
                <CardContent card={card} />
              </motion.div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

const MOBILE_POSITIONS = [
  { top: "0%", left: "2%", rotate: -7 },
  { top: "14%", left: "42%", rotate: 5 },
  { top: "28%", left: "8%", rotate: 8 },
  { top: "42%", left: "40%", rotate: -4 },
  { top: "56%", left: "0%", rotate: -3 },
] as const;

function BuildPage() {
  return (
    <main>
      <OfferingsDeck />
      <InstallPrompt />
    </main>
  );
}
