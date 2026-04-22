import { useEffect, useRef, useState } from "react";
import { Logo } from "@repo/ui/components/logo";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, useInView, useScroll, useTransform } from "motion/react";

export const Route = createFileRoute("/build")({
  head: () => ({ meta: [{ title: "Build — Vibedgames" }] }),
  component: BuildPage,
});

type Accent = {
  text: string;
  bg: string;
  on: string;
  border: string;
  cardBg: string;
};

const ACCENTS = {
  lime: {
    text: "text-lime-300",
    bg: "bg-lime-300",
    on: "text-lime-950",
    border: "border-lime-300/30",
    cardBg: "bg-[oklch(0.2_0.06_135)]",
  },
  cyan: {
    text: "text-cyan-300",
    bg: "bg-cyan-300",
    on: "text-cyan-950",
    border: "border-cyan-300/30",
    cardBg: "bg-[oklch(0.2_0.06_220)]",
  },
  fuchsia: {
    text: "text-fuchsia-300",
    bg: "bg-fuchsia-300",
    on: "text-fuchsia-950",
    border: "border-fuchsia-300/30",
    cardBg: "bg-[oklch(0.2_0.06_320)]",
  },
  amber: {
    text: "text-amber-300",
    bg: "bg-amber-300",
    on: "text-amber-950",
    border: "border-amber-300/30",
    cardBg: "bg-[oklch(0.2_0.06_70)]",
  },
  rose: {
    text: "text-rose-300",
    bg: "bg-rose-300",
    on: "text-rose-950",
    border: "border-rose-300/30",
    cardBg: "bg-[oklch(0.2_0.06_15)]",
  },
} satisfies Record<string, Accent>;

/* ─── Window chrome ───────────────────────────────────────────────────── */

function WindowFrame({
  children,
  url,
  title,
  accent,
}: {
  children: React.ReactNode;
  url?: React.ReactNode;
  title?: string;
  accent: Accent;
}) {
  return (
    <div className="bg-background/80 w-full overflow-hidden rounded-xl border border-white/10 ring-1 ring-inset ring-white/[0.03]">
      <div className="bg-background/60 flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <div className="flex gap-1.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${accent.bg} opacity-80`}
          />
          <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        </div>
        {url ? (
          <div className="text-muted-foreground ml-2 flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-sm bg-white/5 px-2 py-0.5 text-center text-[10px]">
            <span className={`h-1 w-1 rounded-full ${accent.bg}`} />
            <span className="truncate">{url}</span>
          </div>
        ) : title ? (
          <div className="text-muted-foreground ml-2 text-[10px]">{title}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/* ─── Scene primitives (static) ──────────────────────────────────────── */

const STARS = Array.from({ length: 22 }, (_, i) => ({
  id: `star-${i}`,
  x: (i * 37) % 100,
  y: (i * 59) % 100,
}));

const ASTEROIDS = [
  { id: "a", x: 12, y: 22, size: 14 },
  { id: "b", x: 72, y: 18, size: 20 },
  { id: "c", x: 28, y: 68, size: 18 },
  { id: "d", x: 82, y: 62, size: 12 },
  { id: "e", x: 52, y: 42, size: 22 },
];

function StarField({ rocks = true }: { rocks?: boolean }) {
  return (
    <>
      {STARS.map((s) => (
        <span
          key={s.id}
          className="absolute h-px w-px bg-white/70"
          style={{ left: `${s.x}%`, top: `${s.y}%` }}
        />
      ))}
      {rocks &&
        ASTEROIDS.map((a) => (
          <div
            key={a.id}
            className="absolute rounded-full bg-stone-500/70 shadow-inner shadow-black/50"
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              width: a.size,
              height: a.size,
            }}
          />
        ))}
    </>
  );
}

function Ship({
  x,
  y,
  color,
  label,
  labelColor,
}: {
  x: string;
  y: string;
  color: string;
  label?: string;
  labelColor?: string;
}) {
  return (
    <div className="absolute" style={{ left: x, top: y }}>
      <div
        className={`h-3 w-3 ${color}`}
        style={{ clipPath: "polygon(50% 0%, 100% 100%, 50% 75%, 0% 100%)" }}
      />
      {label ? (
        <div
          className={`absolute left-4 top-0 whitespace-nowrap rounded-sm bg-black/55 px-1 py-0.5 font-mono text-[8px] tracking-widest backdrop-blur ${labelColor ?? "text-white/80"}`}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

/* ─── Individual scenes (all static) ─────────────────────────────────── */

function InstallScene({ accent }: { accent: Accent }) {
  return (
    <WindowFrame title="~/my-game — zsh" accent={accent}>
      <div className="bg-black/30 p-5 font-mono text-[11px] leading-5">
        <div className="flex items-center gap-2">
          <span className={accent.text}>❯</span>
          <span className="text-foreground">npx vibedgames skills .</span>
        </div>
        <div className="text-muted-foreground mt-4 space-y-1 border-t border-white/5 pt-4">
          <div>→ Resolving vibedgames@latest</div>
          <div>→ Installing 15 skills</div>
          <div className={`mt-2 ${accent.text}`}>
            <div>  ├── deploy</div>
            <div>  ├── multiplayer</div>
            <div>  ├── generate-sprites</div>
            <div>  ├── shader-fx</div>
            <div>  └── ...</div>
          </div>
          <div className="pt-3">
            <span className={accent.text}>✓</span>
            <span>{"  installed · "}</span>
            <span className="text-foreground/80">.claude/skills/</span>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

function DescribeScene({ accent }: { accent: Accent }) {
  return (
    <WindowFrame
      url={
        <>
          localhost:5173 · <span className={accent.text}>dev</span>
        </>
      }
      accent={accent}
    >
      <div className="grid grid-cols-[0.9fr_1.1fr]">
        <div className="border-r border-white/5 bg-black/40 p-3 font-mono text-[10px] leading-[1.55]">
          <div className="text-muted-foreground/70 mb-2 flex items-center justify-between">
            <span>game.ts</span>
            <span className={`${accent.text} text-[9px] tracking-widest`}>
              ● LIVE
            </span>
          </div>
          <div className="text-muted-foreground space-y-[1px]">
            {[
              { k: "a", t: "import { scene } from '@/engine'" },
              { k: "b", t: "" },
              { k: "c", t: "export const game = scene({" },
              { k: "d", t: "  gravity: 0.2," },
              { k: "e", t: "  asteroids: 5," },
              { k: "f", t: "  ship: new MiningRig()," },
              { k: "g", t: "})" },
            ].map((line, i) => (
              <div key={line.k}>
                <span className="text-muted-foreground/40 mr-2 tabular-nums">
                  {String(i + 1).padStart(2, " ")}
                </span>
                {line.t || "\u00A0"}
              </div>
            ))}
            <div className={accent.text}>
              <span className="text-muted-foreground/40 mr-2 tabular-nums">
                {" 9"}
              </span>
              → hmr: 42ms
            </div>
          </div>
        </div>
        <div className="relative aspect-[4/3] overflow-hidden bg-gradient-to-b from-slate-950 via-slate-950 to-black">
          <StarField rocks />
          <Ship x="44%" y="55%" color={accent.bg} />
          <div className="absolute bottom-1.5 right-1.5 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-[8px] tracking-widest text-white/60 backdrop-blur">
            PREVIEW · 60 FPS
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

function MultiplayerScene({ accent }: { accent: Accent }) {
  return (
    <WindowFrame
      url={
        <>
          localhost:5173 · <span className={accent.text}>sync</span>
        </>
      }
      accent={accent}
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-br from-purple-950/40 via-slate-950 to-black">
        <StarField />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 400 250"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d="M140 155 Q 200 90 260 80"
            stroke="rgb(240 171 252 / 0.6)"
            strokeWidth="1"
            strokeDasharray="3 4"
            fill="none"
          />
        </svg>
        <Ship
          x="32%"
          y="55%"
          color="bg-fuchsia-300"
          label="host"
          labelColor="text-fuchsia-200"
        />
        <Ship
          x="60%"
          y="28%"
          color="bg-cyan-300"
          label="friend"
          labelColor="text-cyan-200"
        />
        <div className="absolute left-2 top-2 flex flex-col gap-1 rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-[9px] text-white/70 backdrop-blur">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${accent.bg}`} />
            <span className={accent.text}>SYNC</span>
            <span className="text-muted-foreground/70">· 28 ms</span>
          </div>
          <div className="text-muted-foreground/70">host · 2 peers</div>
        </div>
        <div className="absolute bottom-2 right-2 w-[140px] overflow-hidden rounded border border-white/10 bg-black/50 p-1.5 font-mono text-[8.5px] leading-snug text-white/60 backdrop-blur">
          <div className="space-y-0.5">
            {[
              ["←", "pos.host"],
              ["→", "pos.friend"],
              ["←", "rock.hit id=04"],
              ["→", "score +12"],
              ["←", "chat emote"],
              ["→", "ack 0x3f"],
            ].map(([arr, t]) => (
              <div key={t} className="flex items-center gap-1">
                <span className={`${accent.text} opacity-70`}>{arr}</span>
                <span>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

function DeployScene({ accent }: { accent: Accent }) {
  return (
    <WindowFrame url="asteroid-miner.vibedgames.com" accent={accent}>
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-b from-amber-950/30 via-slate-950 to-black">
        <StarField />
        <Ship x="32%" y="55%" color="bg-fuchsia-300" />
        <Ship x="60%" y="28%" color="bg-cyan-300" />
        <div className="absolute bottom-3 left-3 w-[190px] overflow-hidden rounded border border-white/10 bg-black/55 p-2 font-mono text-[9.5px] leading-[1.45] text-white/70 backdrop-blur">
          <div className="text-muted-foreground/70 mb-1 flex items-center justify-between text-[8.5px] tracking-widest">
            <span>/deploy</span>
            <span className={accent.text}>■</span>
          </div>
          <div className="space-y-0.5">
            <div>building…</div>
            <div>bundling · 143 KB gz</div>
            <div>uploading → R2</div>
            <div>routing · DNS ok</div>
            <div className={accent.text}>✓ deployed in 4.2s</div>
          </div>
        </div>
        <div
          className="absolute right-3 top-3 flex items-center gap-1.5 rounded-sm border bg-black/70 px-2 py-1 font-mono text-[10px] tracking-[0.3em] backdrop-blur"
          style={{
            borderColor: "rgb(253 230 138 / 0.6)",
            color: "rgb(253 230 138)",
          }}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${accent.bg}`} />
          LIVE
        </div>
      </div>
    </WindowFrame>
  );
}

function PlayScene({ accent }: { accent: Accent }) {
  const games = [
    {
      name: "Asteroid Miner",
      slug: "asteroid-miner",
      players: 4,
      glyph: "⛏",
    },
    { name: "Space Shooter", slug: "space-shooter", players: 2, glyph: "🚀" },
    { name: "Pixel Racer", slug: "pixel-racer", players: 6, glyph: "🏎" },
    { name: "Void Divers", slug: "void-divers", players: 3, glyph: "🌌" },
  ];
  return (
    <WindowFrame
      url={
        <>
          vibedgames.com<span className={accent.text}>/discover</span>
        </>
      }
      accent={accent}
    >
      <div className="relative bg-black/40 p-3">
        <div className="mb-2 flex items-center justify-between px-1 font-mono text-[9px] tracking-widest text-white/50">
          <span>NOW PLAYING</span>
          <span>
            {games.reduce((acc, g) => acc + g.players, 0)} ONLINE
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {games.map((g) => (
            <div
              key={g.slug}
              className="relative overflow-hidden rounded-md border border-white/5 bg-white/[0.02] p-2 text-[10px]"
            >
              <div className="bg-muted relative mb-1.5 flex aspect-[5/3] w-full items-center justify-center rounded text-base">
                <div className="absolute inset-0 [background-image:linear-gradient(135deg,rgba(255,255,255,0.05),transparent)]" />
                <span className="relative z-10">{g.glyph}</span>
                <span className="absolute right-1 top-1 flex h-1.5 w-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${accent.bg}`}
                  />
                </span>
              </div>
              <div className="text-foreground truncate font-medium">
                {g.name}
              </div>
              <div className="text-muted-foreground/60 flex items-center justify-between">
                <span className="truncate">{g.slug}</span>
                <span className={`${accent.text} shrink-0 tabular-nums`}>
                  {g.players} playing
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </WindowFrame>
  );
}

/* ─── Step data ───────────────────────────────────────────────────────── */

type StepDef = {
  id: string;
  num: string;
  kicker: string;
  title: string;
  body: string;
  prompt: { role: string; text: string };
  accent: Accent;
  Scene: (p: { accent: Accent }) => React.JSX.Element;
};

const STEPS: StepDef[] = [
  {
    id: "install",
    num: "01",
    kicker: "Install",
    title: "Add the toolkit",
    body: "One command drops 15 skills into any project. Your LLM gains deploy, multiplayer, sprite generation, shader FX — every tool the platform offers, ready in any conversation.",
    prompt: { role: "$", text: "npx vibedgames skills ." },
    accent: ACCENTS.lime,
    Scene: InstallScene,
  },
  {
    id: "describe",
    num: "02",
    kicker: "Describe",
    title: "Say what you want",
    body: "Describe the game in plain English. Platformer, puzzler, space shooter — anything. The model writes the code, picks the engine, and opens it on localhost with hot-reload.",
    prompt: { role: "you >", text: "build me an asteroid mining game" },
    accent: ACCENTS.cyan,
    Scene: DescribeScene,
  },
  {
    id: "multiplayer",
    num: "03",
    kicker: "Multiplayer",
    title: "Go real-time",
    body: "“Make it multiplayer.” The skill wires state sync, host authority, and reconnection handling into your game. No servers to configure, no networking code to write.",
    prompt: {
      role: "you >",
      text: "add multiplayer so friends can mine together",
    },
    accent: ACCENTS.fuchsia,
    Scene: MultiplayerScene,
  },
  {
    id: "deploy",
    num: "04",
    kicker: "Deploy",
    title: "Ship to a URL",
    body: "A single slash command bundles for production, uploads to the global CDN, and routes DNS. Seconds later your game is playable anywhere on earth.",
    prompt: { role: "you >", text: "/deploy" },
    accent: ACCENTS.amber,
    Scene: DeployScene,
  },
  {
    id: "play",
    num: "05",
    kicker: "Play",
    title: "Players find it",
    body: "Your game lands on vibedgames.com/discover where players jump in, share, and run up the counter. Global CDN edges, zero maintenance on your end.",
    prompt: { role: "↗", text: "vibedgames.com/discover" },
    accent: ACCENTS.rose,
    Scene: PlayScene,
  },
];

/* ─── Stacking card (right column, parallax via motion) ──────────────── */

function StackingCard({
  step,
  index,
  total,
  onActive,
}: {
  step: StepDef;
  index: number;
  total: number;
  onActive: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isLast = index === total - 1;

  // Parallax driven by THIS card's exit: while card's bottom travels from
  // viewport bottom → viewport top, yPercent 0 → 50 so it lags behind the
  // incoming card, creating the "next card slides up over previous" illusion.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["end end", "end start"],
  });
  const y = useTransform(
    scrollYProgress,
    [0, 1],
    isLast ? ["0%", "0%"] : ["0%", "50%"],
  );

  const inView = useInView(ref, { margin: "-45% 0px -45% 0px" });
  useEffect(() => {
    if (inView) onActive(index);
  }, [inView, index, onActive]);

  return (
    <motion.div
      ref={ref}
      style={{ y }}
      className={`relative flex min-h-dvh flex-col justify-center -mt-6 rounded-t-3xl border border-white/5 px-8 py-20 sm:px-12 lg:px-14 ${step.accent.cardBg}`}
    >
      {/* top row */}
      <div className="absolute inset-x-8 top-8 flex items-center justify-between font-mono text-[11px] tracking-[0.3em] sm:inset-x-12 lg:inset-x-14">
        <span
          className={`${step.accent.bg} ${step.accent.on} rounded-full px-2.5 py-0.5 font-semibold uppercase`}
        >
          Step
        </span>
        <span className="text-white/40 tabular-nums">
          {step.num} / {String(total).padStart(2, "0")}
        </span>
      </div>

      {/* centered stack */}
      <div className="flex flex-col gap-7">
        <h2
          className={`font-mono text-[2.5rem] font-bold uppercase leading-[0.9] tracking-[-0.02em] sm:text-[3.75rem] lg:text-[4.5rem]`}
        >
          <span className={`${step.accent.text} opacity-50`}>
            {step.kicker}
          </span>
          <br />
          <span className={step.accent.text}>{step.title}</span>
        </h2>

        <p className="text-foreground/75 max-w-xl text-sm leading-relaxed sm:text-base">
          {step.body}
        </p>

        <div
          className={`bg-background/60 inline-flex max-w-full items-center gap-2.5 self-start rounded-md border ${step.accent.border} px-3.5 py-2.5 font-mono text-xs`}
        >
          <span className={`${step.accent.text} shrink-0 select-none`}>
            {step.prompt.role}
          </span>
          <span className="text-foreground truncate">{step.prompt.text}</span>
        </div>
      </div>

      {/* mobile scene (shown only on < lg since left demo hides) */}
      <div className="mt-12 lg:hidden">
        <step.Scene accent={step.accent} />
      </div>
    </motion.div>
  );
}

/* ─── Pinned left demo ────────────────────────────────────────────────── */

function DemoPanel({ step }: { step: StepDef }) {
  const Scene = step.Scene;
  return (
    <aside className="relative hidden lg:block">
      <div className="sticky top-0 flex h-dvh flex-col items-center justify-center p-10 xl:p-14">
        <div className="w-full max-w-lg">
          <div className="text-muted-foreground mb-6 flex items-center justify-between font-mono text-[10px] tracking-[0.3em]">
            <span className={step.accent.text}>{step.kicker.toUpperCase()}</span>
            <span>DEMO · STEP {step.num}</span>
          </div>
          <Scene accent={step.accent} />
        </div>
      </div>
    </aside>
  );
}

/* ─── Root page ───────────────────────────────────────────────────────── */

function BuildPage() {
  const [active, setActive] = useState(0);
  const activeStep = STEPS[active] ?? STEPS[0];
  if (!activeStep) return null;

  return (
    <div className="relative min-h-dvh">
      <nav className="fixed left-0 top-0 z-30 flex w-full items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="w-6" />
          <span className="font-mono text-sm">vibedgames</span>
        </Link>
      </nav>

      <main className="font-mono">
        {/* Hero */}
        <section className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
          <div className="text-muted-foreground flex items-center gap-3 font-mono text-[10px] tracking-[0.35em]">
            <span className="h-px w-8 bg-white/25" />
            VOL. 01 · HOW IT WORKS
            <span className="h-px w-8 bg-white/25" />
          </div>
          <h1 className="text-foreground font-mono text-[2.75rem] font-bold uppercase leading-[0.92] tracking-[-0.03em] sm:text-[5rem]">
            Ship your game<br />
            <span className="text-muted-foreground/70">in five steps.</span>
          </h1>
          <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
            Infrastructure for vibe-coded games. Multiplayer, deployment,
            hosting — all through skills your LLM already knows.
          </p>
          <div className="bg-card/60 flex items-center gap-2.5 rounded-md border border-lime-300/30 px-4 py-2.5 text-sm">
            <span className="text-lime-300 select-none">$</span>
            <span className="text-foreground">npx vibedgames skills .</span>
          </div>
          <div className="text-muted-foreground/30 mt-10 font-mono text-[10px] tracking-[0.3em]">
            scroll ↓
          </div>
        </section>

        {/* Two-column: demo left (pinned) + stacking cards right */}
        <div className="lg:grid lg:grid-cols-[1fr_1.1fr]">
          <DemoPanel step={activeStep} />
          <div className="relative">
            {STEPS.map((step, i) => (
              <StackingCard
                key={step.id}
                step={step}
                index={i}
                total={STEPS.length}
                onActive={setActive}
              />
            ))}
          </div>
        </div>

        {/* CTA */}
        <section className="relative flex min-h-[70vh] flex-col items-center justify-center gap-8 px-6 py-24 text-center">
          <div className="text-muted-foreground/60 font-mono text-[10px] tracking-[0.35em]">
            ─── READY ───
          </div>
          <h2 className="text-foreground font-mono text-[2rem] font-bold uppercase leading-[0.95] tracking-[-0.02em] sm:text-[3.25rem]">
            Ship your first game<br />
            <span className="text-muted-foreground/70">
              before the coffee cools.
            </span>
          </h2>
          <div className="bg-card/70 flex items-center gap-2.5 rounded-md border border-lime-300/30 px-4 py-2.5 text-sm">
            <span className="text-lime-300 select-none">$</span>
            <span className="text-foreground">npx vibedgames skills .</span>
          </div>
        </section>
      </main>
    </div>
  );
}
