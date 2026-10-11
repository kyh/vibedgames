import { existsSync } from "node:fs";

import { Box, Text, useBoxMetrics, useInput, useWindowSize } from "ink";
import type { BoxProps, DOMElement } from "ink";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { hasExistingProject } from "../state.ts";
import type { BacklogItem } from "./backlog.ts";
import type { FeedLine, Snapshot, Tone, TuiStore } from "./store.ts";
import { TextInput } from "./text-input.tsx";
import { color } from "./theme.ts";
import { FACTORY_WORDMARK, VG_WORDMARK } from "./wordmark.ts";

/** Semantic actions the keyboard dispatches; the controller owns behavior. */
export interface AppController {
  submitSetup: (form: SetupForm) => void;
  /** The slug the form would resolve to (explicit → folder name → idea words). */
  previewSlug: (form: SetupForm) => string | null;
  approve: () => void;
  stop: () => void;
  resume: () => void;
  quit: () => void;
  /** Hold the loop between steps / release the hold. */
  togglePause: () => void;
  /** Stop at the next release point (ship or ship-ready build). */
  stopAtRelease: () => void;
  /** Skip an open checkpoint countdown and continue immediately. */
  continueNow: () => void;
  /** Set (empty = clear) the standing operator directive. */
  redirect: (text: string) => void;
  expandPath: (raw: string) => string;
  /** Where a new game lands when FOLDER is left empty (for the hint). */
  defaultDirLabel: () => string;
}

export interface SetupForm {
  slug: string;
  idea: string;
  dir: string;
  runner: "claude" | "codex";
  model: string;
}

interface ModelChoice {
  name: string;
  description: string;
  runner: "claude" | "codex";
  model: string;
}

/** Curated model menu for the setup screen; --model covers anything else. */
const MODEL_CHOICES: ModelChoice[] = [
  {
    description: "claude-fable-5 — highest craft",
    model: "claude-fable-5",
    name: "fable",
    runner: "claude",
  },
  { description: "claude-opus-4-8", model: "claude-opus-4-8", name: "opus", runner: "claude" },
  {
    description: "claude sonnet — cheaper loop",
    model: "sonnet",
    name: "sonnet",
    runner: "claude",
  },
  {
    description: "codex — gpt-5.6-sol",
    model: "gpt-5.6-sol",
    name: "gpt-5.6-sol",
    runner: "codex",
  },
  { description: "codex — cheaper loop", model: "gpt-5.5", name: "gpt-5.5", runner: "codex" },
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const toneColor = {
  error: color.err,
  info: color.accentDim,
  marker: color.accent,
  success: color.ok,
  text: color.text,
  tool: color.dim,
  warn: color.warn,
} satisfies Record<Tone, string>;

const truncate = (s: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
};

/** Word-wrap into rows of at most `width`; continuations get a 2-col indent. */
const wrapText = (text: string, width: number): string[] => {
  if (width <= 4 || text.length <= width) {
    return [truncate(text, Math.max(1, width))];
  }
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    const cap = rows.length === 0 ? width : width - 2;
    const candidate = row ? `${row} ${word}` : word;
    if (candidate.length <= cap) {
      row = candidate;
      continue;
    }
    if (row) {
      rows.push(rows.length === 0 ? row : `  ${row}`);
    }
    let rest = word;
    while (rest.length > width - 2) {
      rows.push(`  ${rest.slice(0, width - 2)}`);
      rest = rest.slice(width - 2);
    }
    row = rest;
  }
  if (row) {
    rows.push(rows.length === 0 ? row : `  ${row}`);
  }
  return rows;
};

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Clock driver for the spinner / turn timers, ~4 fps. Handing frames the wall
// clock they were drawn at keeps the time-derived text a pure function of props.
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return now;
};

interface PanelProps extends Pick<BoxProps, "position" | "left" | "top" | "flexGrow"> {
  title: string;
  bottomTitle?: string;
  width: number;
  borderColor: string;
  contentPadding?: Pick<BoxProps, "paddingLeft" | "paddingRight" | "paddingTop">;
  children: ReactNode;
}

/** A single-line bordered panel with a title in its top edge, which Ink's borders lack. */
const Panel = ({
  title,
  bottomTitle,
  width,
  borderColor,
  contentPadding,
  children,
  ...frame
}: PanelProps) => {
  const fill = (used: number) => "─".repeat(Math.max(0, width - 2 - used));
  return (
    <Box {...frame} flexDirection="column" width={width} backgroundColor={color.bg}>
      <Text color={borderColor}>{`┌${title}${fill(title.length)}┐`}</Text>
      <Box
        {...contentPadding}
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={bottomTitle === undefined}
      >
        {children}
      </Box>
      {bottomTitle === undefined ? null : (
        <Text color={borderColor}>{`└${fill(bottomTitle.length)}${bottomTitle}┘`}</Text>
      )}
    </Box>
  );
};

const KeyHint = ({ keys, label }: { keys: string; label: string }) => (
  <Text>
    <Text color={color.faint}>[</Text>
    <Text color={color.accent}>{keys}</Text>
    <Text color={color.faint}>]</Text>
    <Text color={color.dim}>{` ${label}`}</Text>
  </Text>
);

const KeyBar = ({ keys, right }: { keys: { keys: string; label: string }[]; right?: string }) => (
  <Box
    flexDirection="row"
    flexShrink={0}
    alignItems="center"
    borderStyle="single"
    borderColor={color.border}
    borderBottom={false}
    borderLeft={false}
    borderRight={false}
    paddingLeft={1}
    paddingRight={1}
  >
    {keys.map((k, i) => (
      <Fragment key={k.keys}>
        {i > 0 && <Text color={color.ghost}>{"   "}</Text>}
        <KeyHint keys={k.keys} label={k.label} />
      </Fragment>
    ))}
    <Box flexGrow={1} />
    {right ? <Text color={color.accentDim}>{right}</Text> : null}
  </Box>
);

// ─── setup screen pong ───────────────────────────────────────────────────────

const PADDLE_H = 5;
// one cell — drawn as a small square glyph
const BALL_W = 1;
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A solid's cell rect on screen. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PongState {
  ball: { x: number; y: number };
  leftY: number;
  rightY: number;
}

/**
 * Per-paddle character: a damped spring toward its target, each with its own
 * stiffness, anticipation, and idle drift, so the two never move in sync.
 */
interface PaddleAi {
  y: number;
  v: number;
  stiffness: number;
  damping: number;
  /** How far ahead of the ball (seconds of vy) this paddle aims. */
  anticipation: number;
  idleFreq: number;
  idlePhase: number;
}

/** Ball kinematics (`p*` is the previous tick's position) plus both paddles. */
interface PongSim {
  left: PaddleAi;
  px: number;
  py: number;
  right: PaddleAi;
  t: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

/** Spin from where the ball met the paddle; the paddle's velocity drags it too. */
const spinOff = (s: PongSim, p: PaddleAi): void => {
  s.vy = clampNum(s.vy + (s.y - (p.y + PADDLE_H / 2)) * 3 + p.v * 0.4, -14, 14);
  if (Math.abs(s.vy) < 2.5) {
    s.vy = s.vy < 0 ? -2.5 : 2.5;
  }
};

/** Paddles: reflect the ball, like a real pong hit. */
const bounceOffPaddles = (s: PongSim, leftX: number, rightX: number): void => {
  if (
    s.vx < 0 &&
    s.x <= leftX + 1 &&
    s.px > leftX + 1 &&
    s.y >= s.left.y - 1 &&
    s.y <= s.left.y + PADDLE_H
  ) {
    s.x = leftX + 1;
    s.vx = Math.abs(s.vx);
    spinOff(s, s.left);
  } else if (
    s.vx > 0 &&
    s.x + BALL_W - 1 >= rightX - 1 &&
    s.px + BALL_W - 1 < rightX - 1 &&
    s.y >= s.right.y - 1 &&
    s.y <= s.right.y + PADDLE_H
  ) {
    s.x = rightX - BALL_W;
    s.vx = -Math.abs(s.vx);
    spinOff(s, s.right);
  }
};

/**
 * Every visible solid (wordmark, setup card) reflects the ball. Bounds are
 * inflated by the ball size so its whole body collides, and the bounce axis
 * comes from where the ball came from — never penetration.
 */
const bounceOffSolids = (s: PongSim, solids: readonly Rect[], top: number): void => {
  for (const r of solids) {
    if (r.width <= 0) {
      continue;
    }
    const L = r.left - BALL_W;
    const R = r.left + r.width;
    const T = r.top - 1;
    const B = r.top + r.height;
    if (s.x <= L || s.x >= R || s.y <= T || s.y >= B) {
      continue;
    }
    if (s.px <= L) {
      s.x = L;
      s.vx = -Math.abs(s.vx);
    } else if (s.px >= R) {
      s.x = R;
      s.vx = Math.abs(s.vx);
    }
    if (s.py <= T) {
      s.y = T;
      s.vy = -Math.abs(s.vy);
    } else if (s.py >= B) {
      s.y = B;
      s.vy = Math.abs(s.vy);
    }
    // Resized into a solid: eject above it.
    if (s.px > L && s.px < R && s.py > T && s.py < B) {
      s.y = Math.max(top, T);
      s.vy = -Math.abs(s.vy);
    }
  }
};

/**
 * A self-playing pong match around the setup screen: the ball bounces off the
 * field edges, the paddles, and every visible solid — the wordmark and the
 * NEW GAME card — whose rects are measured from the live layout.
 */
const usePong = (width: number, height: number, solids: readonly Rect[]): PongState | null => {
  const sim = useRef<PongSim>({
    left: {
      anticipation: 0.35,
      damping: 7.5,
      idleFreq: 0.55,
      idlePhase: 0.8,
      stiffness: 26,
      v: 0,
      y: 4,
    },
    px: 8,
    py: 4,
    right: {
      anticipation: 0.12,
      damping: 9,
      idleFreq: 0.4,
      idlePhase: 3.7,
      stiffness: 38,
      v: 0,
      y: 9,
    },
    t: 0,
    vx: 21,
    vy: 8,
    x: 8,
    y: 4,
  });
  const [state, setState] = useState<PongState | null>(null);
  const playable = width >= 50 && height >= 16;
  // The tick reads the latest layout without restarting on every re-render.
  const solidsRef = useRef(solids);
  useEffect(() => {
    solidsRef.current = solids;
  });

  useEffect(() => {
    if (!playable) {
      return;
    }
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = sim.current;
      s.t += dt;
      const top = 1;
      // above the key bar
      const bottom = height - 3;
      const leftX = 2;
      const rightX = width - 3;
      const fieldMid = top + (bottom - top) / 2;

      // Paddles: spring toward a lead on the ball when it is incoming, drift
      // lazily around mid-field when it is not.
      const drive = (p: PaddleAi, incoming: boolean): void => {
        const target = incoming
          ? clampNum(s.y + s.vy * p.anticipation, top, bottom) - PADDLE_H / 2
          : fieldMid -
            PADDLE_H / 2 +
            Math.sin(s.t * p.idleFreq * Math.PI * 2 + p.idlePhase) * ((bottom - top) / 5);
        p.v += (p.stiffness * (target - p.y) - p.damping * p.v) * dt;
        p.y += p.v * dt;
        if (p.y < top) {
          p.y = top;
          p.v = 0;
        } else if (p.y > bottom - PADDLE_H) {
          p.y = bottom - PADDLE_H;
          p.v = 0;
        }
      };
      drive(s.left, s.vx < 0);
      drive(s.right, s.vx > 0);

      s.px = s.x;
      s.py = s.y;
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      // Top/bottom walls.
      if (s.y <= top) {
        s.y = top;
        s.vy = Math.abs(s.vy);
      } else if (s.y >= bottom) {
        s.y = bottom;
        s.vy = -Math.abs(s.vy);
      }

      bounceOffPaddles(s, leftX, rightX);

      // Screen edges backstop a whiffed paddle so the rally never ends.
      if (s.x <= 0) {
        s.x = 0;
        s.vx = Math.abs(s.vx);
      } else if (s.x >= width - BALL_W) {
        s.x = width - BALL_W;
        s.vx = -Math.abs(s.vx);
      }

      bounceOffSolids(s, solidsRef.current, top);

      setState({
        ball: { x: Math.round(s.x), y: Math.round(s.y) },
        leftY: Math.round(s.left.y),
        rightY: Math.round(s.right.y),
      });
    }, 16);
    return () => clearInterval(id);
  }, [playable, width, height]);

  return playable ? state : null;
};

/** Renders + animates the match. Isolated so the 60fps tick re-renders only this. */
const PongLayer = ({
  width,
  height,
  solids,
}: {
  width: number;
  height: number;
  solids: readonly Rect[];
}) => {
  const pong = usePong(width, height, solids);
  if (!pong) {
    return null;
  }
  return (
    <>
      <Box
        position="absolute"
        left={2}
        top={pong.leftY}
        width={1}
        height={PADDLE_H}
        backgroundColor={color.accentDim}
      />
      <Box
        position="absolute"
        left={width - 3}
        top={pong.rightY}
        width={1}
        height={PADDLE_H}
        backgroundColor={color.accentDim}
      />
      <Box position="absolute" left={pong.ball.x} top={pong.ball.y}>
        <Text color={color.accent}>■</Text>
      </Box>
    </>
  );
};

// ─── setup screen ────────────────────────────────────────────────────────────

interface FieldLabelProps {
  label: string;
  focused: boolean;
}

const FieldLabel = ({ label, focused }: FieldLabelProps) => (
  <Box flexDirection="row">
    <Text bold color={focused ? color.accent : color.faint}>
      {focused ? "▸ " : "  "}
    </Text>
    <Text bold color={focused ? color.text : color.dim}>
      {label}
    </Text>
    <Box flexGrow={1} />
    <Text color={color.faint}>[optional]</Text>
  </Box>
);

interface FieldProps {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  hintTone: string;
  focused: boolean;
  width: number;
  /** Above 1, the field is multiline and ENTER inserts a newline. */
  rows?: number;
  onInput: (value: string) => void;
  onSubmit?: () => void;
}

const Field = ({
  label,
  value,
  placeholder,
  hint,
  hintTone,
  focused,
  width,
  rows,
  onInput,
  onSubmit,
}: FieldProps) => (
  <Box flexDirection="column" paddingBottom={1}>
    <FieldLabel label={label} focused={focused} />
    <Box paddingLeft={2}>
      <TextInput
        value={value}
        placeholder={placeholder}
        focused={focused}
        width={width - 2}
        rows={rows}
        onChange={onInput}
        onSubmit={onSubmit}
      />
    </Box>
    <Box paddingLeft={2}>
      <Text color={hintTone} wrap="truncate-end">
        {hint || " "}
      </Text>
    </Box>
  </Box>
);

// focus index of the multiline INSTRUCTIONS field
const IDEA_FIELD = 1;
// focus index of the model stepper
const MODEL_FIELD = 3;

// One of these seeds the INSTRUCTIONS placeholder each launch — game-level
// one-liners (genre + subject + twist), the altitude we want ideas pitched at.
const IDEA_EXAMPLES = [
  "a cozy roguelike about beekeeping",
  "a rhythm game where you conduct thunderstorms",
  "tower defense played from the tower's point of view",
  "a racing game for ghosts haunting a mansion",
  "a fishing RPG on the moon",
  "a puzzle game about folding tiny origami worlds",
  "a deck-builder where the cards are recipes",
  "a platformer where you play the shadow, not the hero",
  "a farming sim at the bottom of the ocean",
  "a stealth game about a museum cat at night",
  "physics golf across city rooftops",
  "an idle game about running a lighthouse",
  "a survival game inside a snow globe",
  "a detective game where the witnesses are houseplants",
  "a kart racer on library bookshelves",
  "a city builder for ants in a garden",
  "a boss rush where you befriend the bosses instead",
  "a metroidvania inside a grand piano",
  "a horde survivor as the last scarecrow in the field",
  "a dating sim for retired video game villains",
] as const;

const randomIdeaExample = (): string =>
  IDEA_EXAMPLES[Math.floor(Math.random() * IDEA_EXAMPLES.length)] ?? IDEA_EXAMPLES[0];

/** Live hint under FOLDER: what pointing there would do. */
const dirHintFor = (
  controller: AppController,
  dirValue: string,
  dirPath: string,
  adopting: boolean,
): string => {
  if (!dirValue) {
    return `point at a project to build on it — new games land in ${controller.defaultDirLabel()}`;
  }
  if (!existsSync(dirPath)) {
    return "folder will be created";
  }
  return adopting
    ? "✓ existing project detected — the agent builds on what's there"
    : "empty folder — the agent starts from scratch";
};

/** Live hint under SLUG: the derived deploy identity when left blank. */
const slugHintFor = (slug: string, preview: string | null): string => {
  if (slug.trim()) {
    return preview
      ? `deploys to ${preview}.vibedgames.com`
      : "invalid — lowercase letters, digits, hyphens";
  }
  return preview ? `auto: ${preview}.vibedgames.com` : "derived from the folder or instructions";
};

/** A measured box's rect, offset by its parent's position on screen. */
const rectIn = (
  parent: { left: number; top: number },
  box: { left: number; top: number; width: number; height: number },
): Rect => ({
  height: box.height,
  left: parent.left + box.left,
  top: parent.top + box.top,
  width: box.width,
});

const SetupScreen = ({
  controller,
  prefill,
  error,
  width,
  height,
}: {
  controller: AppController;
  prefill: SetupForm;
  error: string | null;
  width: number;
  height: number;
}) => {
  const [slug, setSlug] = useState(prefill.slug);
  const [idea, setIdea] = useState(prefill.idea);
  const [dir, setDir] = useState(prefill.dir);
  const [focus, setFocus] = useState(0);
  // The launch flags are always choice 0, so "don't touch it" keeps them; the
  // curated list follows (minus any duplicate of the launch combo).
  const modelChoices = useMemo<[ModelChoice, ...ModelChoice[]]>(
    () => [
      {
        description: `${prefill.model} via ${prefill.runner}`,
        model: prefill.model,
        name: prefill.model.replace(/^claude-/u, ""),
        runner: prefill.runner,
      },
      ...MODEL_CHOICES.filter((c) => c.model !== prefill.model || c.runner !== prefill.runner),
    ],
    [prefill.model, prefill.runner],
  );
  const [modelIdx, setModelIdx] = useState(0);
  const ideaExample = useMemo(() => randomIdeaExample(), []);
  const choice = modelChoices[modelIdx] ?? modelChoices[0];

  // Ink reports each box's position relative to its parent; the title and card
  // sit inside one centered column, itself a child of the full-screen root.
  const columnRef = useRef<DOMElement>(null);
  const titleRef = useRef<DOMElement>(null);
  const cardRef = useRef<DOMElement>(null);
  const column = useBoxMetrics(columnRef);
  const title = useBoxMetrics(titleRef);
  const card = useBoxMetrics(cardRef);
  const solids = [rectIn(column, title), rectIn(column, card)];

  const submit = () => {
    controller.submitSetup({ dir, idea, model: choice.model, runner: choice.runner, slug });
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      controller.quit();
    } else if (key.tab && key.shift) {
      setFocus((f) => (f + 3) % 4);
    } else if (key.tab) {
      setFocus((f) => (f + 1) % 4);
    }
    // On the MODEL stepper, up/down cycle the choice instead of moving fields.
    else if (key.downArrow && focus === MODEL_FIELD) {
      setModelIdx((i) => (i + 1) % modelChoices.length);
    } else if (key.upArrow && focus === MODEL_FIELD) {
      setModelIdx((i) => (i + modelChoices.length - 1) % modelChoices.length);
    } else if (key.downArrow && focus !== IDEA_FIELD) {
      setFocus((f) => (f + 1) % 4);
    } else if (key.upArrow && focus !== IDEA_FIELD) {
      setFocus((f) => (f + 3) % 4);
    }
    // ENTER in a text field is the field's own submit; the stepper starts here.
    else if (key.return && focus === MODEL_FIELD) {
      submit();
    }
  });

  const dirValue = dir.trim();
  const dirPath = dirValue ? controller.expandPath(dirValue) : "";
  const adopting = Boolean(dirValue) && existsSync(dirPath) && hasExistingProject(dirPath);
  const dirHint = dirHintFor(controller, dirValue, dirPath, adopting);
  const dirHintTone = adopting ? color.ok : color.faint;

  const ideaHint = adopting
    ? "extra direction for the existing project"
    : "what should it build? needed when starting from scratch";

  const preview = controller.previewSlug({
    dir,
    idea,
    model: prefill.model,
    runner: prefill.runner,
    slug,
  });
  const slugHint = slugHintFor(slug, preview);
  const slugHintTone = slug.trim() && !preview ? color.warn : color.faint;

  const formWidth = Math.min(64, Math.max(40, width - 8));
  // Inside the card's border and its two-column padding on each side.
  const fieldWidth = formWidth - 6;
  // The form, subtitle, and key bar take 26 rows; the wordmark adds 7.
  const showWordmark = height >= 33 && width >= 66;
  const modelFocused = focus === MODEL_FIELD;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      backgroundColor={color.bg}
    >
      <PongLayer width={width} height={height} solids={solids} />
      <Box flexGrow={1} />
      <Box ref={columnRef} flexDirection="column" alignItems="center">
        <Box ref={titleRef} flexDirection="column" alignItems="flex-start">
          {showWordmark ? (
            <>
              {VG_WORDMARK.map((line) => (
                <Text key={line} color={color.accentDim}>
                  {line}
                </Text>
              ))}
              {FACTORY_WORDMARK.map((line) => (
                <Text key={line} color={color.accent}>
                  {line}
                </Text>
              ))}
            </>
          ) : (
            <Text bold color={color.accent}>
              VG FACTORY
            </Text>
          )}
          <Box alignSelf="center">
            <Text color={color.faint}>VIBEDGAMES // autonomous game studio</Text>
          </Box>
        </Box>
        <Text> </Text>
        <Box ref={cardRef}>
          <Panel
            title=" NEW GAME "
            width={formWidth}
            borderColor={color.borderActive}
            contentPadding={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}
          >
            <Field
              label="FOLDER"
              value={dir}
              placeholder="~/games/my-prototype"
              hint={dirHint}
              hintTone={dirHintTone}
              focused={focus === 0}
              width={fieldWidth}
              onInput={setDir}
              onSubmit={submit}
            />
            <Field
              label="INSTRUCTIONS"
              value={idea}
              placeholder={ideaExample}
              hint={ideaHint}
              hintTone={color.faint}
              focused={focus === IDEA_FIELD}
              width={fieldWidth}
              rows={3}
              onInput={setIdea}
            />
            <Field
              label="SLUG"
              value={slug}
              placeholder="auto"
              hint={slugHint}
              hintTone={slugHintTone}
              focused={focus === 2}
              width={fieldWidth}
              onInput={setSlug}
              onSubmit={submit}
            />
            <Box flexDirection="column" paddingBottom={1}>
              <FieldLabel label="MODEL" focused={modelFocused} />
              <Box paddingLeft={2}>
                <Box
                  flexDirection="row"
                  flexGrow={1}
                  backgroundColor={modelFocused ? "#232333" : color.ghost}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <Text color={modelFocused ? color.text : color.dim}>{choice.name}</Text>
                  <Box flexGrow={1} />
                  <Text color={modelFocused ? color.accent : color.faint}>⇅</Text>
                </Box>
              </Box>
              <Box paddingLeft={2}>
                <Text color={color.faint}>{choice.description}</Text>
              </Box>
            </Box>
            {error ? <Text color={color.err}>{`✘ ${error}`}</Text> : null}
          </Panel>
        </Box>
      </Box>
      <Box flexGrow={1} />
      <KeyBar
        keys={
          focus === IDEA_FIELD
            ? [
                { keys: "ENTER", label: "NEW LINE" },
                { keys: "TAB", label: "NEXT FIELD" },
                { keys: "ESC", label: "QUIT" },
              ]
            : [
                { keys: "TAB", label: "NEXT FIELD" },
                { keys: "ENTER", label: "START" },
                { keys: "ESC", label: "QUIT" },
              ]
        }
      />
    </Box>
  );
};

// ─── dashboard ───────────────────────────────────────────────────────────────

/** The header's run-status dot and label. */
const runStatus = (running: boolean, stopping: boolean, paused: boolean) => {
  if (!running) {
    return { dot: color.faint, label: "STOPPED" };
  }
  if (stopping) {
    return { dot: color.warn, label: "STOPPING" };
  }
  return paused ? { dot: color.warn, label: "PAUSED" } : { dot: color.ok, label: "RUNNING" };
};

const Header = ({ snapshot, width }: { snapshot: Snapshot; width: number }) => {
  const { setup, state, running, stopping, paused } = snapshot;
  const status = runStatus(running, stopping, paused);
  const idea = setup?.idea || "(existing project)";
  const left = 16 + (setup?.slug.length ?? 0);
  return (
    <Box
      flexDirection="row"
      flexShrink={0}
      alignItems="center"
      borderStyle="single"
      borderColor={color.border}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold color={color.accent}>
        VIBEDGAMES
      </Text>
      <Text color={color.faint}>{" // "}</Text>
      <Text bold color={color.text}>
        {setup?.slug ?? ""}
      </Text>
      <Text color={color.dim}>{`  ${truncate(idea, Math.max(0, width - left - 36))}`}</Text>
      <Box flexGrow={1} />
      <Text color={status.dot}>●</Text>
      <Text bold color={color.dim}>{` ${status.label}`}</Text>
      <Text color={color.ghost}>{"  │  "}</Text>
      <Text bold color={color.text}>
        {`~$${(state?.totalCostUsd ?? 0).toFixed(2)}`}
      </Text>
    </Box>
  );
};

/** How this run publishes: off, automatic, approved-and-waiting, or gated. */
const deployStatus = (setup: Snapshot["setup"], approvalPending: boolean) => {
  if (setup?.noShip) {
    return { fg: color.faint, text: "DEPLOY OFF (--skip-ship)" };
  }
  if (setup?.autoDeploy) {
    return { fg: color.warn, text: "DEPLOY AUTO" };
  }
  if (approvalPending) {
    return { fg: color.accent, text: "APPROVAL PENDING — ships at the next release point" };
  }
  return { fg: color.dim, text: "DEPLOY GATED — [A] approves one release" };
};

const StatusRow = ({ snapshot }: { snapshot: Snapshot }) => {
  const { setup, state, approvalPending } = snapshot;
  const deploy = deployStatus(setup, approvalPending);
  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text color={color.faint}>PHASE </Text>
      <Text bold color={color.accent}>
        {(state?.phase ?? "…").toUpperCase()}
      </Text>
      <Text color={color.faint}>{`  CYCLE ${state?.cycle ?? 0}`}</Text>
      <Text color={color.faint}>{`  ITER ${state?.iteration ?? 0}`}</Text>
      <Text color={color.ghost}>{"  │  "}</Text>
      <Text color={deploy.fg}>{deploy.text}</Text>
      <Box flexGrow={1} />
      <Text color={color.faint}>{setup ? `${setup.runner} · ${setup.model}` : ""}</Text>
    </Box>
  );
};

/** Feed lines expanded to display rows (wrapped or truncated), oldest first. */
const feedRows = (feed: readonly FeedLine[], width: number) => {
  const rows: { key: string; tone: Tone; text: string; bold: boolean }[] = [];
  for (const line of feed) {
    const bold = line.tone === "marker";
    if (line.tone === "text") {
      for (const [i, text] of wrapText(line.text, width).entries()) {
        rows.push({ bold, key: `${line.id}:${i}`, text, tone: line.tone });
      }
    } else {
      rows.push({ bold, key: `${line.id}`, text: truncate(line.text, width), tone: line.tone });
    }
  }
  return rows;
};

/**
 * The feed, pinned to its newest line until scrolled up with the arrows or
 * PgUp/PgDn; scrolling back to the bottom pins it again.
 */
const ActivityPanel = ({
  snapshot,
  width,
  focused,
}: {
  snapshot: Snapshot;
  width: number;
  focused: boolean;
}) => {
  const rows = feedRows(snapshot.feed, Math.max(8, width - 7));
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const [scrolledUp, setScrolledUp] = useState(0);
  const maxScroll = Math.max(0, content.height - viewport.clientHeight);
  const fromBottom = Math.min(scrolledUp, maxScroll);
  const page = Math.max(1, viewport.clientHeight - 1);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setScrolledUp(Math.min(maxScroll, fromBottom + 1));
      } else if (key.downArrow) {
        setScrolledUp(Math.max(0, fromBottom - 1));
      } else if (key.pageUp) {
        setScrolledUp(Math.min(maxScroll, fromBottom + page));
      } else if (key.pageDown) {
        setScrolledUp(Math.max(0, fromBottom - page));
      }
    },
    { isActive: focused },
  );

  return (
    <Panel title=" ACTIVITY " width={width} borderColor={color.border} flexGrow={1}>
      <Box
        ref={viewportRef}
        flexGrow={1}
        flexDirection="column"
        overflow="hidden"
        contentOffsetY={maxScroll - fromBottom}
      >
        <Box
          ref={contentRef}
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
        >
          {rows.map((row) => (
            <Text key={row.key} color={toneColor[row.tone]} bold={row.bold} wrap="truncate-end">
              {row.text || " "}
            </Text>
          ))}
        </Box>
      </Box>
    </Panel>
  );
};

/** Done, then ship-stopper, then everything else. */
const glyphColor = (item: BacklogItem): string => {
  if (item.done) {
    return color.ok;
  }
  return item.priority <= 1 ? color.err : color.accent;
};

const BacklogRow = ({ item, width }: { item: BacklogItem; width: number }) => {
  const glyph = item.done ? "✓" : "▸";
  const glyphFg = glyphColor(item);
  const tag = item.type ? `[${item.type}] ` : "";
  return (
    <Box flexDirection="row">
      <Text color={glyphFg}>{`${glyph} `}</Text>
      <Text color={item.done ? color.faint : color.dim}>
        {truncate(`${tag}${item.title}`, Math.max(4, width - 2))}
      </Text>
    </Box>
  );
};

const BacklogPanel = ({
  backlog,
  width,
  maxRows,
}: {
  backlog: readonly BacklogItem[];
  width: number;
  maxRows: number;
}) => {
  const done = backlog.filter((b) => b.done).length;
  const visible = backlog.slice(0, Math.max(1, maxRows));
  const inner = width - 4;
  return (
    <Panel
      title=" BACKLOG "
      bottomTitle={backlog.length > 0 ? ` ${done}/${backlog.length} DONE ` : undefined}
      width={width}
      borderColor={color.border}
      contentPadding={{ paddingLeft: 1, paddingRight: 1 }}
    >
      {backlog.length === 0 ? (
        <Text color={color.faint}>
          {truncate("empty — the director fills this as it plans", inner)}
        </Text>
      ) : (
        visible.map((item) => <BacklogRow key={item.id} item={item} width={inner} />)
      )}
      {backlog.length > visible.length ? (
        <Text color={color.ghost}>{`  +${backlog.length - visible.length} more`}</Text>
      ) : null}
    </Panel>
  );
};

const DirectiveRow = ({ directive }: { directive: string | null }) => {
  if (!directive) {
    return null;
  }
  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text color={color.accentDim}>◈ DIRECTIVE </Text>
      <Text color={color.dim}>{directive}</Text>
    </Box>
  );
};

const CheckpointBar = ({
  checkpoint,
  now,
}: {
  checkpoint: { message: string; deadline: number };
  now: number;
}) => {
  const left = Math.max(0, Math.ceil((checkpoint.deadline - now) / 1000));
  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text bold color={color.warn}>
        {"⏸ CHECKPOINT "}
      </Text>
      <Text color={color.text}>{checkpoint.message}</Text>
      <Box flexGrow={1} />
      <Text color={color.warn}>{` continuing in ${left}s `}</Text>
      <Text color={color.dim}>· ENTER continue · I respond · S stop</Text>
    </Box>
  );
};

/** What the turn bar says when no subagent is mid-turn. */
const idleMessage = (running: boolean, stopping: boolean): string => {
  if (!running) {
    return "stopped — [ENTER] resumes from the saved phase";
  }
  return stopping ? "stopping — waiting for the current step to wrap up" : "between steps…";
};

const TurnBar = ({ snapshot, now }: { snapshot: Snapshot; now: number }) => {
  const { turn, running, stopping } = snapshot;
  if (!turn) {
    const msg = idleMessage(running, stopping);
    return (
      <Box paddingLeft={1}>
        <Text color={running ? color.dim : color.faint}>{msg}</Text>
      </Box>
    );
  }
  const spinner = SPINNER[Math.floor(now / 250) % SPINNER.length];
  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text color={color.accent}>{`${spinner} `}</Text>
      <Text bold color={color.text}>
        {`${turn.emoji} ${turn.role}`}
      </Text>
      <Text color={color.dim}>{` — ${turn.phase} · cycle ${turn.cycle}${
        turn.iteration === null ? "" : ` · iteration ${turn.iteration}`
      }`}</Text>
      <Box flexGrow={1} />
      <Text color={color.dim}>{`${fmtElapsed(now - turn.startedAt)} · ${turn.events} events`}</Text>
    </Box>
  );
};

/** The dashboard's key bar for the run's current state. */
const keyHints = (
  running: boolean,
  stopping: boolean,
  paused: boolean,
): { keys: string; label: string }[] => {
  if (!running) {
    return [
      { keys: "ENTER", label: "RESUME" },
      { keys: "I", label: "STEER" },
      { keys: "A", label: "APPROVE" },
      { keys: "Q", label: "EXIT" },
    ];
  }
  if (stopping) {
    return [{ keys: "Q", label: "FORCE QUIT" }];
  }
  return [
    { keys: "A", label: "APPROVE" },
    { keys: "S", label: "STOP" },
    { keys: "⇧S", label: "STOP@RELEASE" },
    { keys: "P", label: paused ? "RESUME" : "PAUSE" },
    { keys: "I", label: "STEER" },
    { keys: "Q", label: "QUIT" },
  ];
};

const Dashboard = ({
  snapshot,
  controller,
  width,
  height,
}: {
  snapshot: Snapshot;
  controller: AppController;
  width: number;
  height: number;
}) => {
  const now = useNow();
  const [steering, setSteering] = useState(false);
  const [steerText, setSteerText] = useState("");

  const submitSteer = (): void => {
    controller.redirect(steerText);
    setSteerText("");
    setSteering(false);
  };

  useInput((input, key) => {
    if (steering) {
      if (key.escape) {
        setSteering(false);
      }
      // the overlay input owns every other key
      return;
    }
    if ((key.ctrl && input === "c") || input === "q") {
      controller.quit();
    } else if (input === "S") {
      controller.stopAtRelease();
    } else if (input === "s") {
      controller.stop();
    } else if (input === "a") {
      controller.approve();
    } else if (input === "p") {
      controller.togglePause();
    } else if (input === "i") {
      setSteerText(snapshot.directive ?? "");
      setSteering(true);
    } else if (key.return) {
      if (snapshot.checkpoint) {
        controller.continueNow();
      } else {
        controller.resume();
      }
    }
  });

  const { running, stopping, paused } = snapshot;
  const keys = keyHints(running, stopping, paused);
  const live = snapshot.state?.deployUrl;

  const showBacklog = width >= 96;
  const backlogWidth = 36;
  const overlayWidth = Math.min(70, width - 4);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      backgroundColor={color.bg}
    >
      <Header snapshot={snapshot} width={width} />
      <StatusRow snapshot={snapshot} />
      <Box flexDirection="row" flexGrow={1}>
        <ActivityPanel
          snapshot={snapshot}
          width={showBacklog ? width - backlogWidth : width}
          focused={!steering}
        />
        {showBacklog ? (
          <BacklogPanel
            backlog={snapshot.backlog}
            width={backlogWidth}
            maxRows={Math.max(1, height - 9)}
          />
        ) : null}
      </Box>
      <DirectiveRow directive={snapshot.directive} />
      {snapshot.checkpoint ? (
        <CheckpointBar checkpoint={snapshot.checkpoint} now={now} />
      ) : (
        <TurnBar snapshot={snapshot} now={now} />
      )}
      <KeyBar keys={keys} right={live ? truncate(`LIVE ▸ ${live}`, 40) : undefined} />
      {steering ? (
        <Panel
          title=" STEER THE AGENT "
          width={overlayWidth}
          borderColor={color.borderActive}
          position="absolute"
          left={Math.max(1, Math.floor((width - overlayWidth) / 2))}
          top={Math.max(1, Math.floor(height / 2) - 3)}
          contentPadding={{ paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}
        >
          <TextInput
            focused
            value={steerText}
            placeholder="e.g. focus on mobile controls; make the boss easier"
            width={overlayWidth - 4}
            onChange={setSteerText}
            onSubmit={submitSteer}
          />
          <Text color={color.faint}>ENTER apply · ESC cancel · empty clears the directive</Text>
        </Panel>
      ) : null}
    </Box>
  );
};

// ─── root ────────────────────────────────────────────────────────────────────

export const App = ({
  store,
  controller,
  prefill,
}: {
  store: TuiStore;
  controller: AppController;
  prefill: SetupForm;
}) => {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { columns: width, rows: height } = useWindowSize();

  if (snapshot.screen === "setup") {
    return (
      <SetupScreen
        controller={controller}
        prefill={prefill}
        error={snapshot.setupError}
        width={width}
        height={height}
      />
    );
  }
  return <Dashboard snapshot={snapshot} controller={controller} width={width} height={height} />;
};
