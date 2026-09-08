import type Phaser from "phaser";

import { sealPointerEvents } from "@repo/embed";

import { BASE_W } from "./config";
import type { SpecialReadiness } from "./data/special-readiness";
import { gameInset, isCoarse, touchHudBand } from "./sys/screen";

export type ExpeditionRelic = Readonly<{ id: string; name: string; desc: string }>;
export type ExpeditionOffer = Readonly<{
  name: string;
  desc: string;
  price: number;
  kind: "affordable" | "unaffordable" | "sold";
}>;

export type ExpeditionHudState = Readonly<{
  hearts: number;
  maxHearts: number;
  biomeName: string;
  biome: number;
  depth: number;
  bossAt: number;
  gold: number;
  score: number;
  special: SpecialReadiness;
  bossName: string | null;
  safeRoom: boolean;
  /** Null means the local client has not received the shared build yet. */
  relics: readonly ExpeditionRelic[] | null;
  offer: ExpeditionOffer | null;
  visible: boolean;
}>;

const CSS = `
.lf-build {
  position: fixed;
  z-index: 15;
  box-sizing: border-box;
  width: max-content;
  max-width: var(--lf-build-width);
  color: #d8dee6;
  font-family: monospace;
  line-height: 1.4;
  border: 1px solid #33445e;
  border-radius: 2px;
  background: #0b0e14f5;
  overscroll-behavior: contain;
}
.lf-build[hidden] { display: none; }
.lf-build[open] { width: var(--lf-build-width); }
.lf-build summary {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: .65em;
  padding: .3em .65em;
  color: #34e5c8;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  list-style: none;
}
.lf-build summary::-webkit-details-marker { display: none; }
.lf-build summary::before { content: '+'; }
.lf-build[open] summary::before { content: '−'; }
.lf-build summary:focus-visible, .lf-build-list:focus-visible {
  outline: 2px solid #34e5c8;
  outline-offset: -2px;
}
.lf-build-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: #33445e #0b0e14;
  scrollbar-width: thin;
  padding: 0 .65em .5em;
  touch-action: pan-y;
}
.lf-build-list p { margin: .5em 0 0; }
.lf-build-list strong { display: block; color: #f4f7fb; font-weight: normal; }
.lf-build-list span { color: #a6b6c9; }
@media (orientation: portrait) and (pointer: coarse) {
  .lf-build { display: none; }
}
`;

/** View-only expedition information. The scene still owns every action, clock,
 * purchase and relic; inspecting the safe-room build never mutates a run. */
export class ExpeditionHud {
  private readonly special: Phaser.GameObjects.Text;
  private readonly boss: Phaser.GameObjects.Text;
  private readonly offerTitle: Phaser.GameObjects.Text;
  private readonly offerEffect: Phaser.GameObjects.Text;
  private readonly offerHint: Phaser.GameObjects.Text;
  private readonly build = document.createElement("details");
  private readonly summary = document.createElement("summary");
  private readonly list = document.createElement("div");
  private readonly style = document.createElement("style");
  private readonly releasePointer: () => void;
  private state: ExpeditionHudState | null = null;
  private relicKey: string | null = null;
  private offerKey = "";
  private inset = { left: 0, right: 0, top: 0, bottom: 0 };
  private visible = true;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly hearts: Phaser.GameObjects.Text,
    private readonly info: Phaser.GameObjects.Text,
  ) {
    this.special = this.text("#34e5c8");
    this.boss = this.text("#d8dee6").setOrigin(0.5, 0);
    this.offerTitle = this.text("#ffd15c").setOrigin(0.5, 0);
    this.offerEffect = this.text("#d8dee6").setOrigin(0.5, 0);
    this.offerHint = this.text("#a6b6c9").setOrigin(0.5, 0);
    this.build.className = "lf-build";
    this.build.hidden = true;
    this.build.setAttribute("aria-label", "Owned relics");
    this.list.className = "lf-build-list";
    this.list.tabIndex = 0;
    this.list.setAttribute("role", "region");
    this.list.setAttribute("aria-label", "Relic effects");
    this.summary.textContent = "BUILD";
    this.build.append(this.summary, this.list);
    this.style.textContent = CSS;
    document.head.append(this.style);
    document.body.append(this.build);
    this.releasePointer = sealPointerEvents(this.build, { keepClick: () => true });
    this.build.addEventListener("toggle", this.onToggle);
    this.build.addEventListener("keydown", this.onKeyDown);
    scene.input.on("pointerdown", this.onWorldPointerDown);
    scene.scale.on("resize", this.layout);
    scene.events.on("pause", this.onSuspend);
    scene.events.on("sleep", this.onSuspend);
    scene.events.on("resume", this.onResume);
    scene.events.on("wake", this.onResume);
    scene.events.once("shutdown", this.destroy);
    this.layout();
    this.hideExtras();
  }

  update(state: ExpeditionHudState): void {
    if (this.disposed) return;
    this.state = state;
    this.visible = state.visible;
    const h = Math.max(0, Math.floor(state.hearts));
    const max = Math.max(h, Math.floor(state.maxHearts));
    this.hearts.setText(
      max > 12 ? `♥ ${h}/${max}` : "♥".repeat(h) + "♡".repeat(Math.max(0, max - h)),
    );
    setColor(this.hearts, "#ff4d6d");
    if (this.hearts.style.fontSize !== "12px") this.hearts.setFontSize(12);
    const relicCount = state.relics === null ? "—" : state.relics.length;
    if (this.info.style.fontSize !== "9px") this.info.setFontSize(9);
    setColor(this.info, "#a6b6c9");
    this.info.setText(
      `${state.biomeName} ${state.biome} · DEPTH ${state.depth}/${state.bossAt}\n` +
        `⬡ ${state.gold}   ✦ ${relicCount}   ★ ${state.score}`,
    );
    this.renderSpecial(state.special);
    this.boss.setText(state.bossName ?? "");
    if (state.safeRoom) this.updateBuild(state.relics);
    this.refreshVisibility();
    this.renderOffer();
  }

  /** Versus retains its existing score display and only shares the local cue. */
  updateSpecial(special: SpecialReadiness, visible = true): void {
    if (this.disposed) return;
    this.state = null;
    this.visible = visible;
    this.hideExtras();
    this.renderSpecial(special);
    this.special.setVisible(visible && !this.suspended);
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.refreshVisibility();
  }

  get inspecting(): boolean {
    return this.build.open && !this.build.hidden;
  }

  destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.input.off("pointerdown", this.onWorldPointerDown);
    this.scene.scale.off("resize", this.layout);
    this.scene.events.off("pause", this.onSuspend);
    this.scene.events.off("sleep", this.onSuspend);
    this.scene.events.off("resume", this.onResume);
    this.scene.events.off("wake", this.onResume);
    this.scene.events.off("shutdown", this.destroy);
    this.releasePointer();
    this.build.removeEventListener("toggle", this.onToggle);
    this.build.removeEventListener("keydown", this.onKeyDown);
    this.build.remove();
    this.style.remove();
    this.special.destroy();
    this.boss.destroy();
    this.offerTitle.destroy();
    this.offerEffect.destroy();
    this.offerHint.destroy();
  };

  private text(color: string): Phaser.GameObjects.Text {
    return this.scene.add
      .text(0, 0, "", {
        fontFamily: "monospace",
        fontSize: "9px",
        color,
        stroke: "#05070b",
        strokeThickness: 2,
        lineSpacing: 2,
      })
      .setScrollFactor(0)
      .setDepth(80);
  }

  private renderSpecial(special: SpecialReadiness): void {
    const key = isCoarse() ? "SP" : "K/Y";
    switch (special.kind) {
      case "ready":
        this.special.setText(`${key} SPECIAL · READY`);
        setColor(this.special, "#34e5c8");
        break;
      case "busy":
        this.special.setText(`${key} SPECIAL · BUSY`);
        setColor(this.special, "#d8dee6");
        break;
      case "cooldown":
        this.special.setText(`${key} SPECIAL · ${Math.max(1, Math.ceil(special.remaining))}s`);
        setColor(this.special, "#ffd15c");
        break;
      case "unknown":
        this.special.setText(`${key} SPECIAL · —`);
        setColor(this.special, "#8b95a1");
        break;
    }
  }

  private updateBuild(relics: readonly ExpeditionRelic[] | null): void {
    const key = relics === null ? "unknown" : relics.map((relic) => relic.id).join(",");
    if (key === this.relicKey) return;
    this.relicKey = key;
    this.summary.textContent = `BUILD · ${relics?.length ?? 0}`;
    const entries: HTMLParagraphElement[] = [];
    if (relics === null || relics.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No relics collected yet.";
      entries.push(empty);
    } else {
      for (const relic of relics) {
        const entry = document.createElement("p");
        const name = document.createElement("strong");
        const effect = document.createElement("span");
        name.textContent = relic.name;
        effect.textContent = relic.desc;
        entry.append(name, effect);
        entries.push(entry);
      }
    }
    this.list.replaceChildren(...entries);
  }

  private refreshVisibility(): void {
    const shown = this.visible && !this.suspended;
    this.special.setVisible(shown);
    this.boss.setVisible(shown && Boolean(this.state?.bossName));
    const safe = shown && this.state?.safeRoom === true;
    this.build.hidden = !safe || this.state?.relics === null;
    if (this.build.hidden) this.build.open = false;
    const offer = safe && this.state?.offer !== null;
    this.offerTitle.setVisible(offer);
    this.offerEffect.setVisible(offer);
    this.offerHint.setVisible(offer);
  }

  private hideExtras(): void {
    this.boss.setVisible(false);
    this.offerTitle.setVisible(false);
    this.offerEffect.setVisible(false);
    this.offerHint.setVisible(false);
    this.build.hidden = true;
    this.build.open = false;
  }

  private renderOffer(force = false): void {
    const offer = this.state?.offer;
    if (!offer) return;
    const split = this.build.open && !this.build.hidden;
    const missingGold = Math.max(0, offer.price - (this.state?.gold ?? 0));
    const key = [offer.name, offer.desc, offer.price, offer.kind, missingGold, split].join("|");
    if (!force && key === this.offerKey) return;
    this.offerKey = key;
    const ins = this.inset;
    const width = BASE_W - 16 - ins.left - ins.right;
    const column = split ? width * 0.48 : width;
    const x = split ? BASE_W - 8 - ins.right - column / 2 : (BASE_W + ins.left - ins.right) / 2;
    const y = 83 + ins.top;
    const suffix = offer.kind === "sold" ? "OWNED" : `⬡ ${offer.price}`;
    this.offerTitle.setWordWrapWidth(column).setPosition(x, y).setText(`${offer.name} · ${suffix}`);
    setColor(this.offerTitle, offer.kind === "unaffordable" ? "#ff8b8b" : "#ffd15c");
    this.offerEffect
      .setWordWrapWidth(column)
      .setPosition(x, y + this.offerTitle.height + 2)
      .setText(offer.desc);
    const hint =
      offer.kind === "affordable"
        ? "Walk into the relic to buy"
        : offer.kind === "unaffordable"
          ? `Need ${missingGold} more gold`
          : "Added to the shared build";
    this.offerHint
      .setWordWrapWidth(column)
      .setPosition(x, this.offerEffect.y + this.offerEffect.height + 3)
      .setText(hint);
  }

  private layout = (): void => {
    if (this.disposed) return;
    const ins = gameInset(this.scene);
    this.inset = ins;
    this.hearts.setPosition(8 + ins.left, 6 + ins.top);
    this.info.setPosition(BASE_W - 8 - ins.right, 7 + ins.top + touchHudBand(this.scene));
    this.special.setPosition(8 + ins.left, 22 + ins.top);
    this.boss.setPosition(BASE_W / 2, 34 + ins.top);
    const rect = this.scene.game.canvas.getBoundingClientRect();
    const scale = rect.width / BASE_W;
    this.build.style.left = `${rect.left + (8 + ins.left) * scale}px`;
    this.build.style.top = `${rect.top + (43 + ins.top) * scale}px`;
    this.build.style.setProperty(
      "--lf-build-width",
      `${(BASE_W - 16 - ins.left - ins.right) * 0.46 * scale}px`,
    );
    this.build.style.fontSize = `${Math.max(12, 9 * scale)}px`;
    this.summary.style.minHeight = `${Math.max(44, 20 * scale)}px`;
    this.list.style.maxHeight = `${Math.min(150, 102 * scale)}px`;
    this.renderOffer(true);
  };

  private onToggle = (): void => {
    if (!this.disposed) this.renderOffer();
  };

  private onSuspend = (): void => {
    this.suspended = true;
    this.refreshVisibility();
  };

  private onResume = (): void => {
    this.suspended = false;
    this.refreshVisibility();
  };

  private onWorldPointerDown = (): void => {
    this.build.open = false;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.build.contains(focused)) focused.blur();
    this.renderOffer();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    // A collapsed summary can retain focus after a canvas click. Only its
    // native activation keys belong to it; walking/attacking still reach play.
    // Open inspection keeps native scrolling; Escape and every keyup bubble.
    if (event.key !== "Escape" && (this.build.open || event.key === "Enter" || event.key === " "))
      event.stopPropagation();
  };
}

function setColor(text: Phaser.GameObjects.Text, color: string): void {
  if (text.style.color !== color) text.setColor(color);
}
