// The title screen's controls card — the pause sign's control language
// (method headers, parchment key chips with the chunky brown drop, cream
// action copy) mirrored in Phaser objects so the title teaches controls with
// the same UI the pause overlay does. Groups render side by side as columns;
// content re-renders from the shared CONTROLS manifest per device / connected
// pad (callers rebuild on watchControlContext).

import Phaser from "phaser";
import { controlGroups } from "@repo/embed";
import type { ControlEntry, ControlMethod } from "@repo/embed";

import { CONTROLS } from "../controls";

const METHOD_LABELS = {
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAMERA",
  controller: "CONTROLLER",
} satisfies Record<ControlMethod, string>;

// Palette lifted from the pause sign: parchment #f4ecd6 chips bordered and
// dropped in #6b3f16, chip lettering #4a3010, cream actions #f8f0da, and the
// sign's pale-green group labels #eaffd0.
const CHIP_FILL = 0xf4ecd6;
const CHIP_EDGE = 0x6b3f16;
const CHIP_TEXT = "#4a3010";
const ACTION_TEXT = "#f8f0da";
const LABEL_TEXT = "#eaffd0";
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const CHIP_PAD_X = 8;
const CHIP_H = 22;
const ROW_GAP = 8;
const ROW_PITCH = CHIP_H + ROW_GAP;
const COL_GAP = 36;
const GUTTER = 12;
const LABEL_GAP = 9;
const TEXT_SHADOW = "rgba(58,33,8,0.55)";

const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: FONT,
  fontSize: "10px",
  fontStyle: "bold",
  color: LABEL_TEXT,
};

export type ControlsCardOptions = {
  /** The band the card has to live in. Long groups then reflow into more,
   *  shorter columns whenever that reads larger than uniformly shrinking one
   *  column per method — a landscape phone has width to spare and almost no
   *  height, and 12px copy scaled to a third of size is a smear. */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
};

export type ControlsCard = {
  readonly container: Phaser.GameObjects.Container;
  readonly width: number;
  readonly height: number;
};

/** A built, measured row: its objects plus what they cost horizontally. */
type Row = {
  readonly chip: Phaser.GameObjects.Text;
  readonly action: Phaser.GameObjects.Text;
  readonly chipW: number;
  readonly actionW: number;
};

type Group = { readonly label: string; readonly rows: readonly Row[] };

/**
 * Build the grouped keycap card as a Phaser container (origin at its center).
 * Null when nothing is visible for the current device/pad context.
 */
export function buildControlsCard(
  scene: Phaser.Scene,
  options: ControlsCardOptions = {},
): ControlsCard | null {
  const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length === 0) return null;

  // Measure first: chips right-align against a central gutter like the sign's
  // grid, so every column's width needs its widest chip and action up front.
  const measured: Group[] = groups.map((group) => ({
    label: METHOD_LABELS[group.method],
    rows: group.entries.map((entry) => buildRow(scene, entry)),
  }));

  const probe = scene.add.text(0, 0, METHOD_LABELS.keys, LABEL_STYLE);
  const headerH = Math.ceil(probe.height) + LABEL_GAP;
  probe.destroy();

  const perColumn = bestSplit(measured, headerH, options);
  const container = scene.add.container(0, 0);
  const { width, height } = cardSize(measured, perColumn, headerH);

  let x = -width / 2;
  for (const group of measured) {
    for (let start = 0; start < group.rows.length; start += perColumn) {
      const rows = group.rows.slice(start, start + perColumn);
      // The label repeats on a continued column: an unlabelled column next to
      // a labelled one reads as a different method.
      const label = scene.add.text(0, 0, group.label, LABEL_STYLE).setOrigin(0.5, 0).setAlpha(0.85);
      label.setShadow(0, 1, TEXT_SHADOW, 0);
      const chipCol = Math.max(...rows.map((r) => r.chipW));
      label.setPosition(x + columnWidth(rows) / 2, -height / 2);
      container.add(label);

      let y = -height / 2 + headerH + CHIP_H / 2;
      for (const row of rows) {
        const cx = x + chipCol - row.chipW / 2; // right-aligned to the gutter
        // Chunky parchment chip: hard 3px drop, square pixel corners.
        const drop = scene.add.rectangle(cx, y + 3, row.chipW, CHIP_H, CHIP_EDGE);
        const face = scene.add
          .rectangle(cx, y, row.chipW, CHIP_H, CHIP_FILL)
          .setStrokeStyle(2, CHIP_EDGE);
        row.chip.setPosition(cx, y);
        row.action.setPosition(x + chipCol + GUTTER, y);
        container.add([drop, face, row.chip, row.action]);
        y += ROW_PITCH;
      }
      x += columnWidth(rows) + COL_GAP;
    }
  }

  return { container, width, height };
}

function buildRow(scene: Phaser.Scene, entry: ControlEntry): Row {
  const chip = scene.add
    .text(0, 0, entry.input, {
      fontFamily: FONT,
      fontSize: "12px",
      fontStyle: "bold",
      color: CHIP_TEXT,
    })
    .setOrigin(0.5);
  const action = scene.add
    .text(0, 0, entry.action, { fontFamily: FONT, fontSize: "12px", color: ACTION_TEXT })
    .setOrigin(0, 0.5)
    .setAlpha(0.92);
  action.setShadow(0, 1, TEXT_SHADOW, 0);
  return {
    chip,
    action,
    chipW: Math.ceil(chip.width) + CHIP_PAD_X * 2,
    actionW: Math.ceil(action.width),
  };
}

function columnWidth(rows: readonly Row[]): number {
  return Math.max(...rows.map((r) => r.chipW)) + GUTTER + Math.max(...rows.map((r) => r.actionW));
}

function cardSize(measured: readonly Group[], perColumn: number, headerH: number) {
  let width = 0;
  let columns = 0;
  let tallest = 0;
  for (const group of measured) {
    for (let start = 0; start < group.rows.length; start += perColumn) {
      const rows = group.rows.slice(start, start + perColumn);
      width += columnWidth(rows);
      columns++;
      tallest = Math.max(tallest, rows.length);
    }
  }
  return {
    width: width + COL_GAP * (columns - 1),
    height: headerH + CHIP_H + tallest * ROW_PITCH - ROW_GAP,
    columns,
  };
}

/**
 * Rows per column that render largest inside the caller's band. Ties break to
 * the fewest columns — so an unconstrained card is one column per method, and
 * only a viewport that cannot afford the height spends width instead — and
 * then to the shortest column, which evens out the last one.
 */
function bestSplit(
  measured: readonly Group[],
  headerH: number,
  { maxWidth, maxHeight }: ControlsCardOptions,
): number {
  const longest = Math.max(...measured.map((g) => g.rows.length));
  if (maxWidth === undefined && maxHeight === undefined) return longest;
  let best = longest;
  let bestScale = -1;
  let bestColumns = Number.POSITIVE_INFINITY;
  for (let perColumn = longest; perColumn >= 1; perColumn--) {
    const size = cardSize(measured, perColumn, headerH);
    const scale = Math.min(
      1,
      maxHeight === undefined ? 1 : maxHeight / size.height,
      maxWidth === undefined ? 1 : maxWidth / size.width,
    );
    if (scale > bestScale || (scale === bestScale && size.columns <= bestColumns)) {
      bestScale = scale;
      bestColumns = size.columns;
      best = perColumn;
    }
  }
  return best;
}
