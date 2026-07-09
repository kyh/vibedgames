import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";

import type { FeedLine, Snapshot, Tone, TuiHandlers, TuiStore } from "./store.ts";
import { color, panelBorder } from "./theme.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// Fixed rows around the feed: header(2) + status(1) + panel border(2) +
// turn bar(1) + footer(2).
const CHROME_ROWS = 8;

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
    // hard-split words longer than a full row
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

const fmtSpend = (usd: number): string => `~$${usd.toFixed(2)}`;

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

/** Feed lines expanded to display rows (wrapped or truncated), newest last. */
function feedRows(feed: readonly FeedLine[], width: number, maxRows: number) {
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
  return rows.slice(-maxRows);
}

function Header({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const { setup, state } = snapshot;
  const idea = setup.idea || "(existing project)";
  const left = 12 + 4 + setup.slug.length; // brand + separators + slug
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
        {setup.slug}
      </text>
      <text fg={color.dim}>{`  ${truncate(idea, Math.max(0, width - left - 24))}`}</text>
      <box flexGrow={1} />
      <text fg={color.ok}>●</text>
      <text fg={color.dim}> SPEND </text>
      <text attributes={TextAttributes.BOLD} fg={color.text}>
        {fmtSpend(state?.totalCostUsd ?? 0)}
      </text>
    </box>
  );
}

function StatusRow({ snapshot }: { snapshot: Snapshot }) {
  const { setup, state, approvalPending } = snapshot;
  const deploy = setup.noShip
    ? { text: "DEPLOY OFF (--skip-ship)", fg: color.faint }
    : setup.autoDeploy
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
      <text fg={color.faint}>{setup.model}</text>
    </box>
  );
}

function TurnBar({ snapshot, tick }: { snapshot: Snapshot; tick: number }) {
  const turn = snapshot.turn;
  if (!turn) {
    return (
      <box paddingLeft={1}>
        <text fg={color.faint}>idle — waiting for the next step</text>
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

const FOOTER_KEYS = [
  { keys: "A", label: "APPROVE DEPLOY" },
  { keys: "S", label: "STOP AFTER STEP" },
  { keys: "Q", label: "QUIT" },
] as const;

function Footer({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const live = snapshot.state?.deployUrl;
  const keysWidth = FOOTER_KEYS.reduce((sum, k) => sum + k.keys.length + k.label.length + 3, 0) + 6;
  const budget = width - 2 - keysWidth - 2;
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
      {FOOTER_KEYS.map((k, i) => (
        <Fragment key={k.keys}>
          {i > 0 && <text fg={color.ghost}>{"   "}</text>}
          <text fg={color.faint}>[</text>
          <text fg={color.accent}>{k.keys}</text>
          <text fg={color.faint}>]</text>
          <text fg={color.dim}>{` ${k.label}`}</text>
        </Fragment>
      ))}
      <box flexGrow={1} />
      {live && budget >= 16 ? (
        <text fg={color.accentDim}>{truncate(`LIVE ▸ ${live}`, budget)}</text>
      ) : null}
    </box>
  );
}

export function App({ store, handlers }: { store: TuiStore; handlers: TuiHandlers }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();
  const tick = useTick();

  useKeyboard((key) => {
    if ((key.ctrl && key.name === "c") || key.name === "q") handlers.interrupt();
    else if (key.name === "s") handlers.requestStop();
    else if (key.name === "a") handlers.approve();
  });

  const innerWidth = Math.max(1, width - 4); // panel border(2) + padding(2)
  const maxRows = Math.max(1, height - CHROME_ROWS);
  const rows = feedRows(snapshot.feed, innerWidth, maxRows);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={color.bg}>
      <Header snapshot={snapshot} width={width} />
      <StatusRow snapshot={snapshot} />
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
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexGrow={1} />
        {rows.map((row) => (
          <text
            key={row.key}
            fg={toneColor[row.tone]}
            attributes={row.bold ? TextAttributes.BOLD : undefined}
          >
            {row.text || " "}
          </text>
        ))}
      </box>
      <TurnBar snapshot={snapshot} tick={tick} />
      <Footer snapshot={snapshot} width={width} />
    </box>
  );
}
