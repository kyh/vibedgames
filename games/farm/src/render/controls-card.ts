// The title screen's controls card — the pause sign's control language
// (method headers, parchment key chips with the chunky brown drop, cream
// action copy) mirrored in Phaser objects so the title teaches controls with
// the same UI the pause overlay does. Groups render side by side as columns;
// content re-renders from the shared CONTROLS manifest per device / connected
// pad (callers rebuild on watchControlContext).

import Phaser from "phaser";
import { controlGroups } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "../controls";

const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAMERA",
  controller: "CONTROLLER",
};

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
const COL_GAP = 36;
const GUTTER = 12;

export type ControlsCard = {
  readonly container: Phaser.GameObjects.Container;
  readonly width: number;
  readonly height: number;
};

/**
 * Build the grouped keycap card as a Phaser container (origin at its center).
 * Null when nothing is visible for the current device/pad context.
 */
export function buildControlsCard(scene: Phaser.Scene): ControlsCard | null {
  const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length === 0) return null;

  const container = scene.add.container(0, 0);
  type Column = { nodes: Phaser.GameObjects.GameObject[]; width: number; height: number };
  const columns: Column[] = [];

  for (const group of groups) {
    const nodes: Phaser.GameObjects.GameObject[] = [];

    // Measure first: chips right-align against a central gutter like the
    // sign's grid, so column width needs the widest chip and action up front.
    const chipTexts = group.entries.map((entry) =>
      scene.add
        .text(0, 0, entry.input, {
          fontFamily: FONT,
          fontSize: "12px",
          fontStyle: "bold",
          color: CHIP_TEXT,
        })
        .setOrigin(0.5),
    );
    const actionTexts = group.entries.map((entry) =>
      scene.add
        .text(0, 0, entry.action, {
          fontFamily: FONT,
          fontSize: "12px",
          color: ACTION_TEXT,
        })
        .setOrigin(0, 0.5)
        .setAlpha(0.92),
    );
    for (const action of actionTexts) action.setShadow(0, 1, "rgba(58,33,8,0.55)", 0);
    const chipW = (text: Phaser.GameObjects.Text): number => Math.ceil(text.width) + CHIP_PAD_X * 2;
    const maxChipW = Math.max(...chipTexts.map(chipW));
    const maxActionW = Math.max(...actionTexts.map((t) => Math.ceil(t.width)));
    const colW = maxChipW + GUTTER + maxActionW;

    const label = scene.add
      .text(colW / 2, 0, METHOD_LABELS[group.method], {
        fontFamily: FONT,
        fontSize: "10px",
        fontStyle: "bold",
        color: LABEL_TEXT,
      })
      .setOrigin(0.5, 0)
      .setAlpha(0.85);
    label.setShadow(0, 1, "rgba(58,33,8,0.55)", 0);
    nodes.push(label);

    let y = Math.ceil(label.height) + 9 + CHIP_H / 2;
    group.entries.forEach((_, i) => {
      const chipText = chipTexts[i];
      const actionText = actionTexts[i];
      if (!chipText || !actionText) return;
      const w = chipW(chipText);
      const cx = maxChipW - w / 2; // right-aligned to the gutter
      // Chunky parchment chip: hard 3px drop, square pixel corners.
      const drop = scene.add.rectangle(cx, y + 3, w, CHIP_H, CHIP_EDGE);
      const face = scene.add.rectangle(cx, y, w, CHIP_H, CHIP_FILL).setStrokeStyle(2, CHIP_EDGE);
      chipText.setPosition(cx, y);
      actionText.setPosition(maxChipW + GUTTER, y);
      nodes.push(drop, face, chipText, actionText);
      y += CHIP_H + ROW_GAP;
    });

    columns.push({ nodes, width: colW, height: y - ROW_GAP + CHIP_H / 2 });
  }

  const totalW = columns.reduce((sum, c) => sum + c.width, 0) + COL_GAP * (columns.length - 1);
  const totalH = Math.max(...columns.map((c) => c.height));
  let x = -totalW / 2;
  for (const column of columns) {
    for (const node of column.nodes) {
      // All column nodes are positioned objects (rects/texts).
      if (node instanceof Phaser.GameObjects.Rectangle || node instanceof Phaser.GameObjects.Text) {
        node.setPosition(node.x + x, node.y - totalH / 2);
      }
      container.add(node);
    }
    x += column.width + COL_GAP;
  }

  return { container, width: totalW, height: totalH };
}
