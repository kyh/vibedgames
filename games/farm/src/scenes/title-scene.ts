import Phaser from "phaser";
import { watchControlContext } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad";
import { hasSave, clearSave } from "../systems/save";
import { Sound } from "../render/audio";
import { titleHintText } from "../controls";

export class TitleScene extends Phaser.Scene {
  private onResize?: (gs: Phaser.Structs.Size) => void;
  private readonly pad = new PhysicalGamepad();
  private unwatchControls?: () => void;

  constructor() {
    super("Title");
  }

  create(): void {
    document.getElementById("veil")?.classList.add("hidden");
    const { width, height } = this.scale;

    // cozy sky->grass backdrop
    const bg = this.add.graphics();
    this.drawBackdrop(bg, width, height);
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = (gs: Phaser.Structs.Size) => {
      bg.clear();
      this.drawBackdrop(bg, gs.width, gs.height);
      layout();
    };
    this.scale.on("resize", this.onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) this.scale.off("resize", this.onResize);
    });

    // decorative idle farmer
    const farmer = this.add.sprite(0, 0, "p-idle").setScale(5).play("p-idle");

    const title = this.add
      .text(0, 0, "FARM", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "84px",
        fontStyle: "900",
        color: "#fff6d5",
        align: "center",
        stroke: "#7a4a18",
        strokeThickness: 10,
      })
      .setOrigin(0.5)
      .setLineSpacing(-6);
    title.setShadow(0, 8, "rgba(0,0,0,0.25)", 12, true, true);

    const tag = this.add
      .text(0, 0, "a cozy farming RPG", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "20px",
        color: "#eaffd0",
      })
      .setOrigin(0.5);

    const newBtn = this.makeButton("🌱  New Farm", "#5fae3a");
    const contBtn = this.makeButton("☀  Continue", "#3a86c8");
    const hint = this.add
      .text(0, 0, titleHintText(), {
        fontFamily: "ui-monospace, monospace",
        fontSize: "14px",
        color: "#dfeccc",
        align: "center",
        wordWrap: { width: this.scale.width - 40 },
      })
      .setOrigin(0.5)
      .setAlpha(0.85);
    // Plugging in (or unplugging) a pad while the title is up updates the hint.
    // Scene instances persist across start/stop — drop any stale subscription
    // before adding this run's, and tear it down on shutdown.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => hint.setText(titleHintText()));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unwatchControls?.();
      this.unwatchControls = undefined;
    });

    const save = hasSave();
    contBtn.container.setAlpha(save ? 1 : 0.35);

    newBtn.zone.on("pointerdown", () => {
      Sound.resume();
      Sound.click();
      this.startNew();
    });
    if (save)
      contBtn.zone.on("pointerdown", () => {
        Sound.resume();
        Sound.click();
        this.scene.start("Game", { mode: "continue" });
      });

    this.input.keyboard?.on("keydown-N", () => this.startNew());
    this.input.keyboard?.on("keydown-ENTER", () =>
      save ? this.scene.start("Game", { mode: "continue" }) : this.startNew(),
    );
    if (save)
      this.input.keyboard?.on("keydown-C", () => this.scene.start("Game", { mode: "continue" }));

    const layout = () => {
      const cx = this.scale.width / 2;
      const h = this.scale.height;
      // compact stack for short (landscape phone) viewports
      const compact = h < 520;
      title.setPosition(cx, h * (compact ? 0.2 : 0.26));
      tag.setPosition(cx, title.y + (compact ? 60 : 92));
      farmer.setVisible(!compact).setPosition(cx, tag.y + 96);
      newBtn.container.setPosition(cx, h * (compact ? 0.6 : 0.66));
      contBtn.container.setPosition(cx, newBtn.container.y + (compact ? 62 : 70));
      hint.setPosition(cx, h - (compact ? 14 : 38));
    };
    layout();
  }

  // A on a physical pad confirms, like ENTER: continue when a save exists,
  // else start fresh.
  override update(): void {
    this.pad.update();
    if (this.pad.justPressed("a")) {
      if (hasSave()) this.scene.start("Game", { mode: "continue" });
      else this.startNew();
    }
  }

  private startNew(): void {
    clearSave();
    this.scene.start("Game", { mode: "new" });
  }

  private drawBackdrop(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
    g.fillGradientStyle(0x9fd8f0, 0x9fd8f0, 0x8fce5a, 0x6fb84a, 1);
    g.fillRect(0, 0, w, h);
    // soft sun
    g.fillStyle(0xfff3c4, 0.5);
    g.fillCircle(w * 0.8, h * 0.2, 80);
    g.fillStyle(0xfff3c4, 0.8);
    g.fillCircle(w * 0.8, h * 0.2, 52);
  }

  private makeButton(label: string, color: string) {
    const container = this.add.container(0, 0);
    const bg = this.add.graphics();
    const w = 280,
      h = 56;
    const c = Phaser.Display.Color.HexStringToColor(color).color;
    bg.fillStyle(0x000000, 0.18);
    bg.fillRoundedRect(-w / 2 + 3, -h / 2 + 5, w, h, 14);
    bg.fillStyle(c, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
    bg.lineStyle(3, 0xffffff, 0.5);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
    const txt = this.add
      .text(0, 0, label, {
        fontFamily: "ui-monospace, monospace",
        fontSize: "24px",
        fontStyle: "bold",
        color: "#ffffff",
      })
      .setOrigin(0.5);
    const zone = this.add.zone(0, 0, w, h).setInteractive({ useHandCursor: true });
    container.add([bg, txt, zone]);
    zone.on("pointerover", () => container.setScale(1.05));
    zone.on("pointerout", () => container.setScale(1));
    return { container, zone };
  }
}
