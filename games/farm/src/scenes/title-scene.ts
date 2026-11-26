import type Phaser from "phaser";
import { Display, Scene, Scenes } from "phaser";
import { watchControlContext } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad";
import { clearSave, loadSave } from "../systems/save";
import { Sound } from "../render/audio";
import { buildControlsCard } from "../render/controls-card";
import type { ControlsCard } from "../render/controls-card";
import { mountTouchControls } from "../touch-controls";
import { seasonName, seasonOfDay } from "../data/calendar";

const FARMER_VISIBLE_HEIGHT = 16;
const FARMER_CENTER_OFFSET_Y = -1;

const drawBackdrop = (g: Phaser.GameObjects.Graphics, w: number, h: number) => {
  g.fillGradientStyle(0x9f_d8_f0, 0x9f_d8_f0, 0x8f_ce_5a, 0x6f_b8_4a, 1);
  g.fillRect(0, 0, w, h);
  g.fillStyle(0xff_f3_c4, 0.5);
  g.fillCircle(w * 0.8, h * 0.2, 80);
  g.fillStyle(0xff_f3_c4, 0.8);
  g.fillCircle(w * 0.8, h * 0.2, 52);
};

export class TitleScene extends Scene {
  private onResize?: (gs: Phaser.Structs.Size) => void;
  private readonly pad = new PhysicalGamepad();
  private unwatchControls?: () => void;
  private controlsCard: ControlsCard | null = null;
  private canContinue = false;

  constructor() {
    super("Title");
  }

  create() {
    document.querySelector("#veil")?.classList.add("hidden");
    mountTouchControls();
    const { width, height } = this.scale;

    const bg = this.add.graphics();
    drawBackdrop(bg, width, height);

    const farmer = this.add.sprite(0, 0, "p-idle").setScale(5).play("p-idle");

    const title = this.add
      .text(0, 0, "FARM", {
        align: "center",
        color: "#fff6d5",
        fontFamily: "ui-monospace, monospace",
        fontSize: "84px",
        fontStyle: "900",
        stroke: "#7a4a18",
        strokeThickness: 10,
      })
      .setOrigin(0.5)
      .setLineSpacing(-6);

    title.setShadow(0, 8, "rgba(0,0,0,0.25)", 12, true, true);

    const tag = this.add
      .text(0, 0, "a cozy farming RPG", {
        color: "#eaffd0",
        fontFamily: "ui-monospace, monospace",
        fontSize: "20px",
      })
      .setOrigin(0.5);

    const intro = this.add
      .text(0, 0, "Till → plant → water → sleep", {
        color: "#fff6d5",
        fontFamily: "ui-monospace, monospace",
        fontSize: "14px",
        stroke: "#547f2c",
        strokeThickness: 3,
      })
      .setOrigin(0.5);

    const newBtn = this.makeButton("🌱  New Farm", "#5fae3a");
    const contBtn = this.makeButton("☀  Continue", "#3a86c8");
    let cardBand = "";

    const saved = loadSave();
    this.canContinue = saved !== null;
    contBtn.container.setAlpha(saved ? 1 : 0.35);

    const saveDetail = this.add
      .text(
        0,
        15,
        saved ? `Day ${saved.day} · ${seasonName(seasonOfDay(saved.day))}` : "No saved farm yet",
        { color: "#e5f3ff", fontFamily: "ui-monospace, monospace", fontSize: "11px" },
      )
      .setOrigin(0.5);

    contBtn.text.setFontSize(20).setY(-7);
    contBtn.container.add(saveDetail);

    newBtn.zone.on("pointerdown", () => {
      Sound.resume();
      Sound.click();
      this.startNew();
    });

    if (saved) {
      contBtn.zone.on("pointerdown", () => {
        Sound.resume();
        Sound.click();
        this.scene.start("Game", { mode: "continue" });
      });
    }

    this.input.keyboard?.on("keydown-N", () => {
      this.startNew();
    });
    this.input.keyboard?.on("keydown-ENTER", () =>
      saved ? this.scene.start("Game", { mode: "continue" }) : this.startNew(),
    );

    if (saved) {
      this.input.keyboard?.on("keydown-C", () => this.scene.start("Game", { mode: "continue" }));
    }

    const layout = () => {
      const w = this.scale.width;
      const cx = w / 2;
      const h = this.scale.height;
      const compact = h < 520;
      title.setFontSize(compact ? 50 : 84);
      title.setPosition(cx, h * (compact ? 0.13 : 0.26));
      tag
        .setText(compact ? "Till → plant → water → sleep" : "a cozy farming RPG")
        .setFontSize(compact ? 14 : 20)
        .setPosition(cx, title.y + (compact ? 48 : 92));
      farmer.setVisible(!compact);
      newBtn.container.setPosition(cx, h * (compact ? 0.39 : 0.66));
      contBtn.container.setPosition(cx, newBtn.container.y + (compact ? 60 : 70));
      intro.setVisible(!compact).setPosition(cx, newBtn.container.y - 48);

      const farmerScale = Math.min(
        5,
        Math.max(1, Math.floor((intro.y - tag.y - 44) / FARMER_VISIBLE_HEIGHT)),
      );

      farmer
        .setScale(farmerScale)
        .setPosition(cx, (tag.y + intro.y) / 2 - FARMER_CENTER_OFFSET_Y * farmerScale);
      const top = contBtn.container.y + (compact ? 34 : 38);
      const bottom = h - (compact ? 8 : 16);
      const band = { maxHeight: bottom - top, maxWidth: w - 24 };
      const bandKey = `${Math.round(band.maxWidth)}x${Math.round(band.maxHeight)}`;

      if (bandKey !== cardBand) {
        cardBand = bandKey;
        this.controlsCard?.container.destroy();
        this.controlsCard = buildControlsCard(this, band);
      }

      const card = this.controlsCard;

      if (card) {
        const scale = Math.min(1, band.maxHeight / card.height, band.maxWidth / card.width);
        card.container.setScale(scale).setPosition(cx, bottom - (card.height * scale) / 2);
      }
    };

    if (this.onResize) {
      this.scale.off("resize", this.onResize);
    }

    this.onResize = (gs: Phaser.Structs.Size) => {
      bg.clear();
      drawBackdrop(bg, gs.width, gs.height);
      layout();
    };

    this.scale.on("resize", this.onResize);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) {
        this.scale.off("resize", this.onResize);
      }
    });

    const rebuildCard = () => {
      cardBand = "";
      layout();
    };

    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(rebuildCard);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.unwatchControls?.();
      this.unwatchControls = undefined;
      this.controlsCard = null;
    });
    layout();
  }

  override update() {
    this.pad.update();

    if (this.pad.justPressed("a")) {
      if (this.canContinue) {
        this.scene.start("Game", { mode: "continue" });
      } else {
        this.startNew();
      }
    }
  }

  private startNew() {
    clearSave();
    this.scene.start("Game", { mode: "new" });
  }

  private makeButton(label: string, color: string) {
    const container = this.add.container(0, 0);
    const bg = this.add.graphics();
    const h = 56;
    const w = 280;
    const c = Display.Color.HexStringToColor(color).color;
    bg.fillStyle(0x00_00_00, 0.18);
    bg.fillRoundedRect(-w / 2 + 3, -h / 2 + 5, w, h, 14);
    bg.fillStyle(c, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
    bg.lineStyle(3, 0xff_ff_ff, 0.5);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);

    const txt = this.add
      .text(0, 0, label, {
        color: "#ffffff",
        fontFamily: "ui-monospace, monospace",
        fontSize: "24px",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    const zone = this.add.zone(0, 0, w, h).setInteractive({ useHandCursor: true });
    container.add([bg, txt, zone]);
    zone.on("pointerover", () => container.setScale(1.05));
    zone.on("pointerout", () => container.setScale(1));

    return { container, text: txt, zone };
  }
}
