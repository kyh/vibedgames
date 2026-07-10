import { existsSync } from "node:fs";
import { TextAttributes, type BoxRenderable, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { hasExistingProject } from "../state.ts";
import type { BacklogItem } from "./backlog.ts";
import type { FeedLine, Snapshot, Tone, TuiStore } from "./store.ts";
import { color, panelBorder } from "./theme.ts";

/** Semantic actions the keyboard dispatches; the controller owns behavior. */
export type AppController = {
  submitSetup(form: SetupForm): void;
  /** The slug the form would resolve to (explicit → folder name → idea words). */
  previewSlug(form: SetupForm): string | null;
  approve(): void;
  stop(): void;
  resume(): void;
  quit(): void;
  /** Hold the loop between steps / release the hold. */
  togglePause(): void;
  /** Stop at the next release point (ship or ship-ready build). */
  stopAtRelease(): void;
  /** Skip an open checkpoint countdown and continue immediately. */
  continueNow(): void;
  /** Set (empty = clear) the standing operator directive. */
  redirect(text: string): void;
  expandPath(raw: string): string;
  /** Where a new game lands when FOLDER is left empty (for the hint). */
  defaultDirLabel(): string;
};

export type SetupForm = { slug: string; idea: string; dir: string };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const toneColor: Record<Tone, string> = {
  marker: color.accent,
  text: color.text,
  tool: color.dim,
  info: color.accentDim,
  warn: color.warn,
  error: color.err,
  success: color.ok,
};

const truncate = (s: string, width: number): string =>
  width <= 0 ? "" : s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;

/** Word-wrap into rows of at most `width`; continuations get a 2-col indent. */
function wrapText(text: string, width: number): string[] {
  if (width <= 4 || text.length <= width) return [truncate(text, Math.max(1, width))];
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    const cap = rows.length === 0 ? width : width - 2;
    const candidate = row ? `${row} ${word}` : word;
    if (candidate.length <= cap) {
      row = candidate;
      continue;
    }
    if (row) rows.push(rows.length === 0 ? row : `  ${row}`);
    let rest = word;
    while (rest.length > width - 2) {
      rows.push(`  ${rest.slice(0, width - 2)}`);
      rest = rest.slice(width - 2);
    }
    row = rest;
  }
  if (row) rows.push(rows.length === 0 ? row : `  ${row}`);
  return rows;
}

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Elapsed-time driver for the spinner / turn clock, ~4 fps.
function useTick(): number {
  const [elapsed, setElapsed] = useState(0);
  const [start] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - start), 250);
    return () => clearInterval(id);
  }, [start]);
  return elapsed;
}

function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <Fragment>
      <text fg={color.faint}>[</text>
      <text fg={color.accent}>{keys}</text>
      <text fg={color.faint}>]</text>
      <text fg={color.dim}>{` ${label}`}</text>
    </Fragment>
  );
}

function KeyBar({ keys, right }: { keys: { keys: string; label: string }[]; right?: string }) {
  return (
    <box
      flexDirection="row"
      alignItems="center"
      border={["top"]}
      borderStyle="single"
      customBorderChars={panelBorder}
      borderColor={color.border}
      paddingLeft={1}
      paddingRight={1}
    >
      {keys.map((k, i) => (
        <Fragment key={k.keys}>
          {i > 0 && <text fg={color.ghost}>{"   "}</text>}
          <KeyHint keys={k.keys} label={k.label} />
        </Fragment>
      ))}
      <box flexGrow={1} />
      {right ? <text fg={color.accentDim}>{right}</text> : null}
    </box>
  );
}

// ─── setup screen pong ───────────────────────────────────────────────────────

const PADDLE_H = 5;
const BALL_W = 1; // one cell — drawn as a small square glyph
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type PongState = {
  ball: { x: number; y: number };
  leftY: number;
  rightY: number;
};

/**
 * Per-paddle character: a damped spring toward its target, each with its own
 * stiffness, anticipation, and idle drift, so the two never move in sync.
 */
type PaddleAi = {
  y: number;
  v: number;
  stiffness: number;
  damping: number;
  /** How far ahead of the ball (seconds of vy) this paddle aims. */
  anticipation: number;
  idleFreq: number;
  idlePhase: number;
};

/**
 * A self-playing pong match around the setup screen: the ball bounces off the
 * field edges, the paddles, and every visible solid — the wordmark and the
 * NEW GAME card — whose rects are measured from the live layout each tick.
 */
function usePong(
  width: number,
  height: number,
  solids: RefObject<BoxRenderable | null>[],
): PongState | null {
  const sim = useRef({
    x: 8,
    y: 4,
    px: 8,
    py: 4,
    vx: 21,
    vy: 8,
    t: 0,
    left: {
      y: 4,
      v: 0,
      stiffness: 26,
      damping: 7.5,
      anticipation: 0.35,
      idleFreq: 0.55,
      idlePhase: 0.8,
    } as PaddleAi,
    right: {
      y: 9,
      v: 0,
      stiffness: 38,
      damping: 9,
      anticipation: 0.12,
      idleFreq: 0.4,
      idlePhase: 3.7,
    } as PaddleAi,
  });
  const [state, setState] = useState<PongState | null>(null);
  const playable = width >= 50 && height >= 16;

  useEffect(() => {
    if (!playable) {
      setState(null);
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
      const bottom = height - 3; // above the key bar
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

      // Paddles: reflect, with spin from where the ball met the paddle — the
      // paddle's own velocity also drags the ball, like a real pong hit.
      const spin = (p: PaddleAi): void => {
        s.vy = clampNum(s.vy + (s.y - (p.y + PADDLE_H / 2)) * 3 + p.v * 0.4, -14, 14);
        if (Math.abs(s.vy) < 2.5) s.vy = s.vy < 0 ? -2.5 : 2.5;
      };
      if (
        s.vx < 0 &&
        s.x <= leftX + 1 &&
        s.px > leftX + 1 &&
        s.y >= s.left.y - 1 &&
        s.y <= s.left.y + PADDLE_H
      ) {
        s.x = leftX + 1;
        s.vx = Math.abs(s.vx);
        spin(s.left);
      } else if (
        s.vx > 0 &&
        s.x + BALL_W - 1 >= rightX - 1 &&
        s.px + BALL_W - 1 < rightX - 1 &&
        s.y >= s.right.y - 1 &&
        s.y <= s.right.y + PADDLE_H
      ) {
        s.x = rightX - BALL_W;
        s.vx = -Math.abs(s.vx);
        spin(s.right);
      }

      // Screen edges backstop a whiffed paddle so the rally never ends.
      if (s.x <= 0) {
        s.x = 0;
        s.vx = Math.abs(s.vx);
      } else if (s.x >= width - BALL_W) {
        s.x = width - BALL_W;
        s.vx = -Math.abs(s.vx);
      }

      // Every visible solid (wordmark, setup card) reflects the ball. Bounds
      // are inflated by the ball size so its whole body collides, and the
      // bounce axis comes from where the ball came from — never penetration.
      for (const ref of solids) {
        const r = ref.current;
        if (!r || r.width <= 0) continue;
        const L = r.x - BALL_W;
        const R = r.x + r.width;
        const T = r.y - 1;
        const B = r.y + r.height;
        if (s.x <= L || s.x >= R || s.y <= T || s.y >= B) continue;
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

      setState({
        ball: { x: Math.round(s.x), y: Math.round(s.y) },
        leftY: Math.round(s.left.y),
        rightY: Math.round(s.right.y),
      });
    }, 16);
    return () => clearInterval(id);
  }, [playable, width, height, solids]);

  return playable ? state : null;
}

/** Renders + animates the match. Isolated so the 60fps tick re-renders only this. */
function PongLayer({
  width,
  height,
  solids,
}: {
  width: number;
  height: number;
  solids: RefObject<BoxRenderable | null>[];
}) {
  const pong = usePong(width, height, solids);
  if (!pong) return null;
  return (
    <Fragment>
      <box
        position="absolute"
        left={2}
        top={pong.leftY}
        width={1}
        height={PADDLE_H}
        backgroundColor={color.accentDim}
      />
      <box
        position="absolute"
        left={width - 3}
        top={pong.rightY}
        width={1}
        height={PADDLE_H}
        backgroundColor={color.accentDim}
      />
      <text position="absolute" left={pong.ball.x} top={pong.ball.y} fg={color.accent}>
        ■
      </text>
    </Fragment>
  );
}

// ─── setup screen ────────────────────────────────────────────────────────────

type FieldLabelProps = { label: string; focused: boolean };

function FieldLabel({ label, focused }: FieldLabelProps) {
  return (
    <box flexDirection="row">
      <text fg={focused ? color.accent : color.faint} attributes={TextAttributes.BOLD}>
        {focused ? "▸ " : "  "}
      </text>
      <text fg={focused ? color.text : color.dim} attributes={TextAttributes.BOLD}>
        {label}
      </text>
      <box flexGrow={1} />
      <text fg={color.faint}>[optional]</text>
    </box>
  );
}

type FieldProps = {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  hintTone: string;
  focused: boolean;
  onInput: (value: string) => void;
  onSubmit: () => void;
};

function Field({
  label,
  value,
  placeholder,
  hint,
  hintTone,
  focused,
  onInput,
  onSubmit,
}: FieldProps) {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <FieldLabel label={label} focused={focused} />
      <box paddingLeft={2}>
        <input
          focused={focused}
          value={value}
          placeholder={placeholder}
          onInput={onInput}
          onSubmit={onSubmit}
          backgroundColor={color.ghost}
          focusedBackgroundColor="#232333"
          textColor={color.text}
          focusedTextColor={color.text}
          placeholderColor={color.faint}
          cursorColor={color.accent}
        />
      </box>
      <box paddingLeft={2}>
        <text fg={hintTone}>{hint || " "}</text>
      </box>
    </box>
  );
}

type TextareaFieldProps = {
  label: string;
  initialValue: string;
  placeholder: string;
  hint: string;
  focused: boolean;
  onInput: (value: string) => void;
};

/** Multiline sibling of Field — ENTER inserts a newline while it's focused. */
function TextareaField({
  label,
  initialValue,
  placeholder,
  hint,
  focused,
  onInput,
}: TextareaFieldProps) {
  const area = useRef<TextareaRenderable | null>(null);
  return (
    <box flexDirection="column" paddingBottom={1}>
      <FieldLabel label={label} focused={focused} />
      <box paddingLeft={2}>
        <textarea
          ref={area}
          focused={focused}
          initialValue={initialValue}
          placeholder={placeholder}
          height={3}
          onContentChange={() => onInput(area.current?.plainText ?? "")}
          backgroundColor={color.ghost}
          focusedBackgroundColor="#232333"
          textColor={color.text}
          focusedTextColor={color.text}
          placeholderColor={color.faint}
          cursorColor={color.accent}
        />
      </box>
      <box paddingLeft={2}>
        <text fg={color.faint}>{hint || " "}</text>
      </box>
    </box>
  );
}

const IDEA_FIELD = 1; // focus index of the multiline INSTRUCTIONS field

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

function SetupScreen({
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
}) {
  const [slug, setSlug] = useState(prefill.slug);
  const [idea, setIdea] = useState(prefill.idea);
  const [dir, setDir] = useState(prefill.dir);
  const [focus, setFocus] = useState(0);
  const [ideaExample] = useState(randomIdeaExample);
  const titleRef = useRef<BoxRenderable | null>(null);
  const cardRef = useRef<BoxRenderable | null>(null);
  const [solids] = useState<RefObject<BoxRenderable | null>[]>(() => [titleRef, cardRef]);

  const submit = () => controller.submitSetup({ slug, idea, dir });

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) controller.quit();
    else if (key.name === "tab" && key.shift) setFocus((f) => (f + 2) % 3);
    else if (key.name === "tab") setFocus((f) => (f + 1) % 3);
    else if (key.name === "down" && focus !== IDEA_FIELD) setFocus((f) => (f + 1) % 3);
    else if (key.name === "up" && focus !== IDEA_FIELD) setFocus((f) => (f + 2) % 3);
    // In the textarea, ENTER makes a new line — TAB out to start.
    else if (key.name === "return" && focus !== IDEA_FIELD) submit();
  });

  // Live hint under FOLDER: what pointing there would do.
  const dirValue = dir.trim();
  const dirPath = dirValue ? controller.expandPath(dirValue) : "";
  const adopting = Boolean(dirValue) && existsSync(dirPath) && hasExistingProject(dirPath);
  const dirHint = !dirValue
    ? `point at a project to build on it — new games land in ${controller.defaultDirLabel()}`
    : !existsSync(dirPath)
      ? "folder will be created"
      : adopting
        ? "✓ existing project detected — the agent builds on what's there"
        : "empty folder — the agent starts from scratch";
  const dirHintTone = adopting ? color.ok : color.faint;

  const ideaHint = adopting
    ? "extra direction for the existing project"
    : "what should it build? needed when starting from scratch";

  // Live hint under SLUG: the derived deploy identity when left blank.
  const preview = controller.previewSlug({ slug, idea, dir });
  const slugHint = slug.trim()
    ? preview
      ? `deploys to ${preview}.vibedgames.com`
      : "invalid — lowercase letters, digits, hyphens"
    : preview
      ? `auto: ${preview}.vibedgames.com`
      : "derived from the folder or instructions";
  const slugHintTone = slug.trim() && !preview ? color.warn : color.faint;

  const formWidth = Math.min(64, Math.max(40, width - 8));
  const showWordmark = height >= 26 && width >= 66;

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={color.bg}>
      <PongLayer width={width} height={height} solids={solids} />
      <box flexGrow={1} />
      <box flexDirection="column" alignItems="center">
        <box ref={titleRef} flexDirection="column" alignItems="flex-start">
          {showWordmark ? (
            <Fragment>
              <ascii-font
                text="GAME"
                font="tiny"
                color={color.accentDim}
                backgroundColor={color.bg}
              />
              <ascii-font
                text="FACTORY"
                font="slick"
                color={color.accent}
                backgroundColor={color.bg}
              />
            </Fragment>
          ) : (
            <text attributes={TextAttributes.BOLD} fg={color.accent}>
              GAME FACTORY
            </text>
          )}
          <text alignSelf="center" fg={color.faint}>
            VIBEDGAMES // autonomous game studio
          </text>
        </box>
        <text> </text>
        <box
          ref={cardRef}
          border
          borderStyle="single"
          customBorderChars={panelBorder}
          borderColor={color.borderActive}
          title=" NEW GAME "
          titleAlignment="left"
          backgroundColor={color.bg}
          flexDirection="column"
          width={formWidth}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
        >
          <Field
            label="FOLDER"
            value={dir}
            placeholder="~/games/my-prototype"
            hint={dirHint}
            hintTone={dirHintTone}
            focused={focus === 0}
            onInput={setDir}
            onSubmit={submit}
          />
          <TextareaField
            label="INSTRUCTIONS"
            initialValue={prefill.idea}
            placeholder={ideaExample}
            hint={ideaHint}
            focused={focus === IDEA_FIELD}
            onInput={setIdea}
          />
          <Field
            label="SLUG"
            value={slug}
            placeholder="auto"
            hint={slugHint}
            hintTone={slugHintTone}
            focused={focus === 2}
            onInput={setSlug}
            onSubmit={submit}
          />
          {error ? <text fg={color.err}>{`✘ ${error}`}</text> : null}
        </box>
      </box>
      <box flexGrow={1} />
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
    </box>
  );
}

// ─── dashboard ───────────────────────────────────────────────────────────────

function Header({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const { setup, state, running, stopping, paused } = snapshot;
  const status = running
    ? stopping
      ? { dot: color.warn, label: "STOPPING" }
      : paused
        ? { dot: color.warn, label: "PAUSED" }
        : { dot: color.ok, label: "RUNNING" }
    : { dot: color.faint, label: "STOPPED" };
  const idea = setup?.idea || "(existing project)";
  const left = 16 + (setup?.slug.length ?? 0);
  return (
    <box
      flexDirection="row"
      alignItems="center"
      border={["bottom"]}
      borderStyle="single"
      customBorderChars={panelBorder}
      borderColor={color.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <text attributes={TextAttributes.BOLD} fg={color.accent}>
        VIBEDGAMES
      </text>
      <text fg={color.faint}>{" // "}</text>
      <text attributes={TextAttributes.BOLD} fg={color.text}>
        {setup?.slug ?? ""}
      </text>
      <text fg={color.dim}>{`  ${truncate(idea, Math.max(0, width - left - 36))}`}</text>
      <box flexGrow={1} />
      <text fg={status.dot}>●</text>
      <text attributes={TextAttributes.BOLD} fg={color.dim}>{` ${status.label}`}</text>
      <text fg={color.ghost}>{"  │  "}</text>
      <text attributes={TextAttributes.BOLD} fg={color.text}>
        {`~$${(state?.totalCostUsd ?? 0).toFixed(2)}`}
      </text>
    </box>
  );
}

function StatusRow({ snapshot }: { snapshot: Snapshot }) {
  const { setup, state, approvalPending } = snapshot;
  const deploy = setup?.noShip
    ? { text: "DEPLOY OFF (--skip-ship)", fg: color.faint }
    : setup?.autoDeploy
      ? { text: "DEPLOY AUTO", fg: color.warn }
      : approvalPending
        ? { text: "APPROVAL PENDING — ships at the next release point", fg: color.accent }
        : { text: "DEPLOY GATED — [A] approves one release", fg: color.dim };
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg={color.faint}>PHASE </text>
      <text attributes={TextAttributes.BOLD} fg={color.accent}>
        {(state?.phase ?? "…").toUpperCase()}
      </text>
      <text fg={color.faint}>{`  CYCLE ${state?.cycle ?? 0}`}</text>
      <text fg={color.faint}>{`  ITER ${state?.iteration ?? 0}`}</text>
      <text fg={color.ghost}>{"  │  "}</text>
      <text fg={deploy.fg}>{deploy.text}</text>
      <box flexGrow={1} />
      <text fg={color.faint}>{setup ? `${setup.runner} · ${setup.model}` : ""}</text>
    </box>
  );
}

/** Feed lines expanded to display rows (wrapped or truncated), oldest first. */
function feedRows(feed: readonly FeedLine[], width: number) {
  const rows: { key: string; tone: Tone; text: string; bold: boolean }[] = [];
  for (const line of feed) {
    const bold = line.tone === "marker";
    if (line.tone === "text") {
      wrapText(line.text, width).forEach((text, i) =>
        rows.push({ key: `${line.id}:${i}`, tone: line.tone, text, bold }),
      );
    } else {
      rows.push({ key: `${line.id}`, tone: line.tone, text: truncate(line.text, width), bold });
    }
  }
  return rows;
}

function ActivityPanel({
  snapshot,
  width,
  focused,
}: {
  snapshot: Snapshot;
  width: number;
  focused: boolean;
}) {
  const rows = feedRows(snapshot.feed, Math.max(8, width - 7));
  return (
    <box
      border
      borderStyle="single"
      customBorderChars={panelBorder}
      borderColor={color.border}
      title=" ACTIVITY "
      titleAlignment="left"
      backgroundColor={color.bg}
      flexDirection="column"
      flexGrow={1}
      width={width}
    >
      <scrollbox
        flexGrow={1}
        focused={focused}
        stickyScroll
        stickyStart="bottom"
        scrollY
        scrollX={false}
        paddingLeft={1}
        paddingRight={1}
      >
        {rows.map((row) => (
          <text
            key={row.key}
            fg={toneColor[row.tone]}
            attributes={row.bold ? TextAttributes.BOLD : undefined}
          >
            {row.text || " "}
          </text>
        ))}
      </scrollbox>
    </box>
  );
}

function BacklogRow({ item, width }: { item: BacklogItem; width: number }) {
  const glyph = item.done ? "✓" : "▸";
  const glyphFg = item.done ? color.ok : item.priority <= 1 ? color.err : color.accent;
  const tag = item.type ? `[${item.type}] ` : "";
  return (
    <box flexDirection="row">
      <text fg={glyphFg}>{`${glyph} `}</text>
      <text fg={item.done ? color.faint : color.dim}>
        {truncate(`${tag}${item.title}`, Math.max(4, width - 2))}
      </text>
    </box>
  );
}

function BacklogPanel({
  backlog,
  width,
  maxRows,
}: {
  backlog: readonly BacklogItem[];
  width: number;
  maxRows: number;
}) {
  const done = backlog.filter((b) => b.done).length;
  const visible = backlog.slice(0, Math.max(1, maxRows));
  const inner = width - 4;
  return (
    <box
      border
      borderStyle="single"
      customBorderChars={panelBorder}
      borderColor={color.border}
      title=" BACKLOG "
      titleAlignment="left"
      bottomTitle={backlog.length > 0 ? ` ${done}/${backlog.length} DONE ` : undefined}
      bottomTitleAlignment="right"
      backgroundColor={color.bg}
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
    >
      {backlog.length === 0 ? (
        <text fg={color.faint}>
          {truncate("empty — the director fills this as it plans", inner)}
        </text>
      ) : (
        visible.map((item) => <BacklogRow key={item.id} item={item} width={inner} />)
      )}
      {backlog.length > visible.length ? (
        <text fg={color.ghost}>{`  +${backlog.length - visible.length} more`}</text>
      ) : null}
    </box>
  );
}

function DirectiveRow({ directive }: { directive: string | null }) {
  if (!directive) return null;
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg={color.accentDim}>◈ DIRECTIVE </text>
      <text fg={color.dim}>{directive}</text>
    </box>
  );
}

function CheckpointBar({ checkpoint }: { checkpoint: { message: string; deadline: number } }) {
  const left = Math.max(0, Math.ceil((checkpoint.deadline - Date.now()) / 1000));
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text attributes={TextAttributes.BOLD} fg={color.warn}>
        {"⏸ CHECKPOINT "}
      </text>
      <text fg={color.text}>{checkpoint.message}</text>
      <box flexGrow={1} />
      <text fg={color.warn}>{` continuing in ${left}s `}</text>
      <text fg={color.dim}>· ENTER continue · I respond · S stop</text>
    </box>
  );
}

function TurnBar({ snapshot, tick }: { snapshot: Snapshot; tick: number }) {
  const { turn, running, stopping } = snapshot;
  if (!turn) {
    const msg = running
      ? stopping
        ? "stopping — waiting for the current step to wrap up"
        : "between steps…"
      : "stopped — [ENTER] resumes from the saved phase";
    return (
      <box paddingLeft={1}>
        <text fg={running ? color.dim : color.faint}>{msg}</text>
      </box>
    );
  }
  const spinner = SPINNER[Math.floor(tick / 250) % SPINNER.length];
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg={color.accent}>{`${spinner} `}</text>
      <text attributes={TextAttributes.BOLD} fg={color.text}>
        {`${turn.emoji} ${turn.role}`}
      </text>
      <text fg={color.dim}>{` — ${turn.phase} · cycle ${turn.cycle}${
        turn.iteration !== null ? ` · iteration ${turn.iteration}` : ""
      }`}</text>
      <box flexGrow={1} />
      <text
        fg={color.dim}
      >{`${fmtElapsed(Date.now() - turn.startedAt)} · ${turn.events} events`}</text>
    </box>
  );
}

function Dashboard({
  snapshot,
  controller,
  width,
  height,
}: {
  snapshot: Snapshot;
  controller: AppController;
  width: number;
  height: number;
}) {
  const tick = useTick();
  const [steering, setSteering] = useState(false);
  const [steerText, setSteerText] = useState("");

  const submitSteer = (): void => {
    controller.redirect(steerText);
    setSteerText("");
    setSteering(false);
  };

  useKeyboard((key) => {
    if (steering) {
      if (key.name === "escape") setSteering(false);
      return; // the overlay input owns every other key
    }
    if ((key.ctrl && key.name === "c") || key.name === "q") controller.quit();
    else if (key.name === "s" && key.shift) controller.stopAtRelease();
    else if (key.name === "s") controller.stop();
    else if (key.name === "a") controller.approve();
    else if (key.name === "p") controller.togglePause();
    else if (key.name === "i") {
      setSteerText(snapshot.directive ?? "");
      setSteering(true);
    } else if (key.name === "return") {
      if (snapshot.checkpoint) controller.continueNow();
      else controller.resume();
    }
  });

  const { running, stopping, paused } = snapshot;
  const keys = running
    ? stopping
      ? [{ keys: "Q", label: "FORCE QUIT" }]
      : [
          { keys: "A", label: "APPROVE" },
          { keys: "S", label: "STOP" },
          { keys: "⇧S", label: "STOP@RELEASE" },
          { keys: "P", label: paused ? "RESUME" : "PAUSE" },
          { keys: "I", label: "STEER" },
          { keys: "Q", label: "QUIT" },
        ]
    : [
        { keys: "ENTER", label: "RESUME" },
        { keys: "I", label: "STEER" },
        { keys: "A", label: "APPROVE" },
        { keys: "Q", label: "EXIT" },
      ];
  const live = snapshot.state?.deployUrl;

  const showBacklog = width >= 96;
  const backlogWidth = 36;

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={color.bg}>
      <Header snapshot={snapshot} width={width} />
      <StatusRow snapshot={snapshot} />
      <box flexDirection="row" flexGrow={1}>
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
      </box>
      <DirectiveRow directive={snapshot.directive} />
      {snapshot.checkpoint ? (
        <CheckpointBar checkpoint={snapshot.checkpoint} />
      ) : (
        <TurnBar snapshot={snapshot} tick={tick} />
      )}
      <KeyBar keys={keys} right={live ? truncate(`LIVE ▸ ${live}`, 40) : undefined} />
      {steering ? (
        <box
          position="absolute"
          left={Math.max(1, Math.floor((width - Math.min(70, width - 4)) / 2))}
          top={Math.max(1, Math.floor(height / 2) - 3)}
          width={Math.min(70, width - 4)}
          border
          borderStyle="single"
          customBorderChars={panelBorder}
          borderColor={color.borderActive}
          title=" STEER THE AGENT "
          titleAlignment="left"
          backgroundColor={color.bg}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          zIndex={10}
        >
          <input
            focused
            value={steerText}
            placeholder="e.g. focus on mobile controls; make the boss easier"
            onInput={setSteerText}
            onSubmit={submitSteer}
            backgroundColor={color.ghost}
            focusedBackgroundColor="#232333"
            textColor={color.text}
            focusedTextColor={color.text}
            placeholderColor={color.faint}
            cursorColor={color.accent}
          />
          <text fg={color.faint}>ENTER apply · ESC cancel · empty clears the directive</text>
        </box>
      ) : null}
    </box>
  );
}

// ─── root ────────────────────────────────────────────────────────────────────

export function App({
  store,
  controller,
  prefill,
}: {
  store: TuiStore;
  controller: AppController;
  prefill: SetupForm;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

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
}
