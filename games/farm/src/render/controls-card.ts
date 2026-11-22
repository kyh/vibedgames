import type Phaser from "phaser";
import { controlGroups } from "@repo/embed";
import type { ControlEntry, ControlMethod } from "@repo/embed";

import { CONTROLS } from "../controls";

const METHOD_LABELS = {
  camera: "CAMERA",
  controller: "CONTROLLER",
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
} satisfies Record<ControlMethod, string>;

const CHIP_FILL = 0xf4_ec_d6;
const CHIP_EDGE = 0x6b_3f_16;
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
  color: LABEL_TEXT,
  fontFamily: FONT,
  fontSize: "10px",
  fontStyle: "bold",
};

export interface ControlsCardOptions {
  /** The band the card has to live in. Long groups then reflow into more,
   *  shorter columns whenever that reads larger than uniformly shrinking one
   *  column per method — a landscape phone has width to spare and almost no
   *  height, and 12px copy scaled to a third of size is a smear. */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

export interface ControlsCard {
  readonly container: Phaser.GameObjects.Container;
  readonly width: number;
  readonly height: number;
}

interface Row {
  readonly chip: Phaser.GameObjects.Text;
  readonly action: Phaser.GameObjects.Text;
  readonly chipW: number;
  readonly actionW: number;
}

interface Group {
  readonly label: string;
  readonly rows: readonly Row[];
}

const buildRow = (scene: Phaser.Scene, entry: ControlEntry) => {
  const chip = scene.add
    .text(0, 0, entry.input, {
      color: CHIP_TEXT,
      fontFamily: FONT,
      fontSize: "12px",
      fontStyle: "bold",
    })
    .setOrigin(0.5);

  const action = scene.add
    .text(0, 0, entry.action, { color: ACTION_TEXT, fontFamily: FONT, fontSize: "12px" })
    .setOrigin(0, 0.5)
    .setAlpha(0.92);

  action.setShadow(0, 1, TEXT_SHADOW, 0);

  return {
    action,
    actionW: Math.ceil(action.width),
    chip,
    chipW: Math.ceil(chip.width) + CHIP_PAD_X * 2,
  };
};

const columnWidth = (rows: readonly Row[]) =>
  Math.max(...rows.map((r) => r.chipW)) + GUTTER + Math.max(...rows.map((r) => r.actionW));

const cardSize = (measured: readonly Group[], perColumn: number, headerH: number) => {
  let width = 0;
  let columns = 0;
  let tallest = 0;

  for (const group of measured) {
    for (let start = 0; start < group.rows.length; start += perColumn) {
      const rows = group.rows.slice(start, start + perColumn);
      width += columnWidth(rows);
      columns += 1;
      tallest = Math.max(tallest, rows.length);
    }
  }

  return {
    columns,
    height: headerH + CHIP_H + tallest * ROW_PITCH - ROW_GAP,
    width: width + COL_GAP * (columns - 1),
  };
};

const bestSplit = (
  measured: readonly Group[],
  headerH: number,
  { maxWidth, maxHeight }: ControlsCardOptions,
) => {
  const longest = Math.max(...measured.map((g) => g.rows.length));

  if (maxWidth === undefined && maxHeight === undefined) {
    return longest;
  }

  let best = longest;
  let bestScale = -1;
  let bestColumns = Number.POSITIVE_INFINITY;

  for (let perColumn = longest; perColumn >= 1; perColumn -= 1) {
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
};

/**
 * Build the grouped keycap card as a Phaser container (origin at its center).
 * Null when nothing is visible for the current device/pad context.
 */
export const buildControlsCard = (scene: Phaser.Scene, options: ControlsCardOptions = {}) => {
  const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const groups = controlGroups(CONTROLS, { coarse });

  if (groups.length === 0) {
    return null;
  }

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
      const label = scene.add.text(0, 0, group.label, LABEL_STYLE).setOrigin(0.5, 0).setAlpha(0.85);
      label.setShadow(0, 1, TEXT_SHADOW, 0);
      const chipCol = Math.max(...rows.map((r) => r.chipW));
      label.setPosition(x + columnWidth(rows) / 2, -height / 2);
      container.add(label);

      let y = -height / 2 + headerH + CHIP_H / 2;

      for (const row of rows) {
        const cx = x + chipCol - row.chipW / 2;
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

  return { container, height, width };
};
