// The end-of-match card: verdict ribbon, the local hero's line, and the
// PLAY AGAIN / BACK TO MENU buttons. Screen-space in the unrotated HUD camera.

import { safeAreaInset } from "@vibedgames/gamepad";
import type Phaser from "phaser";

import type { MatchResult } from "../scenes/game-scene";
import { FONT } from "./font";
import { reducedMotion } from "./presentation-settings";
import { heroSheetTex } from "./sprites";

export type ResultAction = "again" | "menu";

interface ResultButton {
  bg: Phaser.GameObjects.NineSlice;
  label: Phaser.GameObjects.Text;
  action: ResultAction;
}
interface ResultPersonal {
  frame: Phaser.GameObjects.Image;
  portrait: Phaser.GameObjects.Image;
  name: Phaser.GameObjects.Text;
  role: Phaser.GameObjects.Text;
  kda: Phaser.GameObjects.Text;
  kdaLabel: Phaser.GameObjects.Text;
  stats: { value: Phaser.GameObjects.Text; label: Phaser.GameObjects.Text }[];
}

const stopPointer = (
  _p: Phaser.Input.Pointer,
  _x: number,
  _y: number,
  event: Phaser.Types.Input.EventData,
): void => {
  event.stopPropagation();
};

interface Verdict {
  ribbon: string;
  title: string;
}

const verdictOf = (neutral: boolean, won: boolean): Verdict => {
  if (neutral) {
    return { ribbon: "ui-ribbon-blue", title: "MATCH COMPLETE" };
  }
  if (won) {
    return { ribbon: "ui-ribbon-yellow", title: "VICTORY" };
  }
  return { ribbon: "ui-ribbon-red", title: "DEFEAT" };
};

const fullHeightOf = (narrow: boolean, both: boolean): number => {
  if (narrow) {
    return both ? 520 : 450;
  }
  return 430;
};

const buttonX = (narrow: boolean, both: boolean, index: number): number => {
  if (narrow || !both) {
    return 0;
  }
  return index === 0 ? -140 : 140;
};

const layoutPersonalPortrait = (p: ResultPersonal, narrow: boolean): void => {
  const px = narrow ? -116 : -205;
  const py = narrow ? -59 : -8;
  const size = narrow ? 90 : 138;
  p.frame.setPosition(px, py).setDisplaySize(size, size);
  p.portrait.setPosition(px, py).setDisplaySize(size - 12, size - 12);
  p.name
    .setOrigin(0, 0.5)
    .setPosition(narrow ? -55 : -106, narrow ? -77 : -58)
    .setFontSize(narrow ? 24 : 27);
  p.role
    .setOrigin(0, 0.5)
    .setAlign("left")
    .setPosition(narrow ? -55 : -106, narrow ? -45 : -24)
    .setFontSize(narrow ? 12 : 14);
};

const layoutPersonalStats = (p: ResultPersonal, narrow: boolean, width: number): void => {
  p.kda.setPosition(narrow ? 0 : 94, narrow ? 22 : 27).setFontSize(narrow ? 34 : 36);
  p.kdaLabel.setPosition(narrow ? 0 : 94, narrow ? 49 : 54).setFontSize(narrow ? 11 : 12);
  for (const [i, stat] of p.stats.entries()) {
    const x = -width / 2 + 28 + (i + 0.5) * ((width - 56) / 4);
    stat.value.setPosition(x, narrow ? 94 : 92).setFontSize(narrow ? 20 : 21);
    stat.label.setPosition(x, narrow ? 119 : 114).setFontSize(narrow ? 10 : 11);
  }
};

export class ResultCard {
  readonly root: Phaser.GameObjects.Container;
  readonly buttons: ResultButton[] = [];
  private readonly veil: Phaser.GameObjects.Rectangle;
  private readonly panel: Phaser.GameObjects.NineSlice;
  private readonly ribbon: Phaser.GameObjects.NineSlice;
  private readonly title: Phaser.GameObjects.Text;
  private readonly context: Phaser.GameObjects.Text;
  private readonly personal: ResultPersonal | null = null;
  private readonly neutral: Phaser.GameObjects.Text | null = null;
  private clicked = false;
  private readonly scene: Phaser.Scene;
  readonly data: MatchResult;
  readonly canReplay: boolean;

  constructor(
    scene: Phaser.Scene,
    data: MatchResult,
    canReplay: boolean,
    onLeave: (action: ResultAction) => void,
  ) {
    this.scene = scene;
    this.data = data;
    this.canReplay = canReplay;
    this.veil = scene.add
      .rectangle(0, 0, 1, 1, 0x05_08_0e, 0.68)
      .setOrigin(0)
      .setDepth(50_000)
      .setInteractive();
    this.veil.on("pointerdown", stopPointer);
    this.root = scene.add.container(0, 0).setDepth(50_001);
    const won = data.kind === "assigned" && data.outcome === "victory";
    const neutral = data.kind === "unassigned";
    const verdict = verdictOf(neutral, won);
    this.panel = scene.add.nineslice(0, 0, "ui-carved9", 0, 600, 236, 20, 20, 20, 20);
    this.ribbon = scene.add.nineslice(0, 0, verdict.ribbon, 0, 560, 100, 58, 58, 22, 22);
    const text = (value: string, size: number, color: string): Phaser.GameObjects.Text =>
      scene.add
        .text(0, 0, value, { align: "center", color, fontFamily: FONT, fontSize: size })
        .setOrigin(0.5);
    this.title = text(verdict.title, 64, won ? "#5a3a10" : "#f4eee0");
    this.title.setStroke(won ? "#fff3c4" : "#283342", 5);
    const minutes = Math.floor(data.duration / 60);
    const seconds = Math.floor(data.duration % 60)
      .toString()
      .padStart(2, "0");
    this.context = text(
      `${data.winner ? `${data.winner.toUpperCase()} PREVAILS  ·  ` : ""}${minutes}:${seconds} MATCH`,
      15,
      "#fff0ca",
    );
    this.root.add([this.panel, this.ribbon, this.title, this.context]);
    if (data.kind === "assigned") {
      const frame = scene.add.image(0, 0, "ui-panel");
      const portrait = scene.add.image(0, 0, heroSheetTex(data.heroId, data.team), 0);
      const name = text(data.heroName, 26, "#4a3320");
      const role = text(`${data.heroTitle}\n${data.role}`, 14, "#6b533c");
      const kda = text(`${data.kills} / ${data.deaths} / ${data.assists}`, 36, "#4a3320");
      const kdaLabel = text("KILLS  /  DEATHS  /  ASSISTS", 12, "#6b533c");
      const stats = [
        { label: "LEVEL", value: data.level },
        { label: "LAST HITS", value: data.lastHits },
        { label: "DENIES", value: data.denies },
        { label: "GOLD HELD", value: Math.floor(data.gold) },
      ].map((stat) => ({
        label: text(stat.label, 11, "#6b533c"),
        value: text(String(stat.value), 21, "#4a3320"),
      }));
      this.root.add([frame, portrait, name, role, kda, kdaLabel]);
      for (const stat of stats) {
        this.root.add([stat.value, stat.label]);
      }
      this.personal = { frame, kda, kdaLabel, name, portrait, role, stats };
    } else {
      this.neutral = text("The battle has ended.\nNo personal hero was assigned.", 22, "#4a3320");
      this.root.add(this.neutral);
    }
    const addButton = (action: ResultAction, color: "blue" | "red", caption: string): void => {
      // Input picks the top-most hit by each object's own depth, and a
      // container lends none to its children: without this the veil wins.
      const bg = scene.add
        .nineslice(0, 0, `ui-btn-${color}`, 0, 250, 60, 28, 28, 20, 26)
        .setDepth(this.veil.depth + 1)
        .setInteractive({ useHandCursor: true });
      const label = text(caption, 19, "#1e3a44");
      this.root.add([bg, label]);
      this.buttons.push({ action, bg, label });
      bg.on("pointerover", () => {
        if (!this.clicked && !reducedMotion()) {
          scene.tweens.add({ duration: 100, scale: 1.04, targets: [bg, label] });
        }
      });
      bg.on("pointerout", () =>
        scene.tweens.add({ duration: 100, scale: 1, targets: [bg, label] }),
      );
      bg.on(
        "pointerdown",
        (p: Phaser.Input.Pointer, x: number, y: number, event: Phaser.Types.Input.EventData) => {
          stopPointer(p, x, y, event);
          if (this.clicked) {
            return;
          }
          this.clicked = true;
          bg.setTexture(`ui-btn-${color}-pressed`);
          label.setText("…").setY(bg.y);
          scene.time.delayedCall(40, () => onLeave(action));
        },
      );
    };
    if (canReplay) {
      addButton("again", "blue", "⟳  PLAY AGAIN");
    }
    addButton("menu", "red", "⌂  BACK TO MENU");
    this.layout();
    if (!reducedMotion()) {
      this.root.setAlpha(0);
      scene.tweens.add({ alpha: 1, duration: 250, targets: this.root });
    }
  }

  layout(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const inset = safeAreaInset();
    const narrow = W < 600;
    const width = narrow ? 360 : 600;
    const both = this.buttons.length === 2;
    const fit = Math.min(
      1,
      (W - inset.left - inset.right - 24) / width,
      (H - inset.top - inset.bottom - 24) / fullHeightOf(narrow, both),
    );
    this.veil.setSize(W, H);
    this.root
      .setPosition(
        (W + inset.left - inset.right) / 2,
        (H + inset.top - inset.bottom) / 2 - (narrow && both ? 28 : 0) * fit,
      )
      .setScale(fit);
    this.layoutFrame(narrow, width);
    this.layoutPersonal(narrow, width);
    this.neutral?.setPosition(0, 15).setFontSize(narrow ? 18 : 22);
    this.layoutButtons(narrow, both);
  }

  private layoutFrame(narrow: boolean, width: number): void {
    this.ribbon.setPosition(0, narrow ? -178 : -155).setSize(narrow ? 360 : 560, narrow ? 88 : 104);
    this.title.setPosition(0, narrow ? -184 : -163).setFontSize(this.titleSize(narrow));
    this.context.setPosition(0, narrow ? -128 : -105).setFontSize(narrow ? 12 : 15);
    this.panel.setPosition(0, narrow ? 18 : 20).setSize(width, narrow ? 266 : 226);
  }

  private titleSize(narrow: boolean): number {
    if (this.data.kind === "unassigned") {
      return narrow ? 30 : 44;
    }
    return narrow ? 46 : 64;
  }

  private layoutPersonal(narrow: boolean, width: number): void {
    const p = this.personal;
    if (!p) {
      return;
    }
    layoutPersonalPortrait(p, narrow);
    layoutPersonalStats(p, narrow, width);
  }

  private layoutButtons(narrow: boolean, both: boolean): void {
    for (const [i, button] of this.buttons.entries()) {
      const x = buttonX(narrow, both, i);
      const y = narrow ? 194 + i * 66 : 186;
      button.bg.setPosition(x, y);
      button.label.setPosition(x, y - (this.clicked ? 0 : 4));
    }
  }

  destroy(): void {
    this.root.destroy(true);
    this.veil.destroy();
  }
}
