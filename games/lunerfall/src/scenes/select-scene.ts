import Phaser from "phaser";
import { notifyGameStarted, watchControlContext } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";
import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, HERO_ORIGIN_Y } from "../config";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import { readRunRecap, type RunRecap } from "../data/run-recap";
import {
  buyUpgrade,
  isUnlocked,
  loadBestScore,
  loadMeta,
  type MetaState,
  unlockHero,
  UPGRADES,
} from "../data/meta";
import { HubView } from "../hub/hub-view";
import { isCoarse } from "../sys/screen";

/** Screen-space hub only. The same authored sprites, selection and purchase
 * callbacks serve every input; the expedition retains its baked world camera. */
export class SelectScene extends Phaser.Scene {
  private index = 0;
  private sprites: Phaser.GameObjects.Sprite[] = [];
  private ring: Phaser.GameObjects.Ellipse | null = null;
  private arrow: Phaser.GameObjects.Text | null = null;
  private backdrop: Phaser.GameObjects.Image | null = null;
  private shade: Phaser.GameObjects.Rectangle | null = null;
  private view: HubView | null = null;
  private meta: MetaState = { shards: 0, unlocked: [], bestDepth: 0, runs: 0, upgrades: {} };
  private net: "off" | "coop" | "vs" = "off";
  private code = "";
  private shopOpen = false;
  private shopIndex = 0;
  private pad: PhysicalGamepad | null = null;
  private recap: RunRecap | null = null;
  private k = 1;
  private selectedX = 0;
  private selectedY = 0;
  private reducedMotion: MediaQueryList | null = null;

  constructor() {
    super("select");
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Phaser supplies untyped scene data; parse at this boundary.
  init(data: unknown): void {
    this.recap =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Untrusted scene-entry payload, not game-domain state.
      typeof data === "object" && data !== null && "recap" in data
        ? readRunRecap(data.recap)
        : null;
    // Phaser retains old truthy scene data. Consume the receipt exactly once.
    this.sys.settings.data = {};
  }

  create(): void {
    this.meta = loadMeta();
    this.sprites = [];
    this.shopOpen = false;
    this.shopIndex = 0;
    const search = new URLSearchParams(location.search);
    const code = search.get("party");
    this.code = code?.toUpperCase() ?? "";
    this.net = code ? (search.get("mode") === "vs" ? "vs" : "coop") : "off";
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.backdrop = this.add
      .image(0, 0, "env:backdrop")
      .setOrigin(0)
      .setTint(0x7385a8)
      .setAlpha(0.5);
    this.shade = this.add.rectangle(0, 0, 1, 1, 0x05070b, 0.42).setOrigin(0);
    this.ring = this.add.ellipse(0, 0, 46, 16).setStrokeStyle(1.5, 0x34e5c8, 0.95);
    this.arrow = this.add
      .text(0, 0, "▼", { fontFamily: "monospace", fontSize: "12px", color: "#34e5c8" })
      .setOrigin(0.5);
    for (const name of HERO_ORDER) {
      const sprite = this.add
        .sprite(0, 0, name, firstFrame(this, name))
        .setOrigin(0.5, HERO_ORIGIN_Y);
      sprite.play(`${name}:idle`);
      this.sprites.push(sprite);
    }
    this.view = new HubView(
      {
        hero: (index) => this.pickHero(index),
        go: () => this.go(),
        forge: () => this.toggleShop(),
        offer: (index) => this.pickUpgrade(index),
        mode: (mode) => this.toggleNet(mode),
        layout: this.layout,
      },
      this.recap,
    );
    this.pad = new PhysicalGamepad();
    this.pad.update();
    const kb = this.input.keyboard;
    kb?.on("keydown", this.keyDown);
    const unwatch = watchControlContext(() => this.refresh());
    window.addEventListener("resize", this.layout);
    let cleaned = false;
    const cleanup = (restoreViewport: boolean): void => {
      if (cleaned) return;
      cleaned = true;
      this.events.off(Phaser.Scenes.Events.SHUTDOWN, shutdown);
      this.events.off(Phaser.Scenes.Events.DESTROY, destroy);
      window.removeEventListener("resize", this.layout);
      unwatch();
      kb?.off("keydown", this.keyDown);
      this.pad?.destroy();
      this.pad = null;
      this.view?.destroy();
      this.view = null;
      this.recap = null;
      this.sprites = [];
      // DisplayList owns these objects, including direct Game.destroy's path.
      this.ring = null;
      this.arrow = null;
      this.backdrop = null;
      this.shade = null;
      // Restore only when a running game can accept a scene transition.
      if (restoreViewport) this.scale.setGameSize(BASE_W, BASE_H);
    };
    const shutdown = (): void => cleanup(true);
    const destroy = (): void => cleanup(false);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, shutdown);
    this.events.once(Phaser.Scenes.Events.DESTROY, destroy);
    this.refresh();
  }

  /** DOM stages determine positions in CSS pixels. Only this scene changes the
   * render size; cleanup restores the original BASE_W/BASE_H before a descent. */
  private readonly layout = (): void => {
    const view = this.view;
    if (!view) return;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.k = Math.min(1, 720 / h);
    const rw = Math.round(w * this.k);
    const rh = Math.round(h * this.k);
    if (this.scale.width !== rw || this.scale.height !== rh) this.scale.setGameSize(rw, rh);
    this.backdrop?.setDisplaySize(rw, rh);
    this.shade?.setDisplaySize(rw, rh);
    this.sprites.forEach((sprite, index) => {
      const node = view.heroes[index];
      const name = HERO_ORDER[index];
      if (!node || !name) return;
      const rect = node.getBoundingClientRect();
      const art = node.querySelector(".lf-hub-art")?.getBoundingClientRect();
      if (!art) return;
      const selected = index === this.index;
      const scale = Math.min(rect.width / 27, art.height / 31, selected ? 4.2 : 2.9) * this.k;
      const x = (rect.left + rect.width / 2) * this.k;
      const y = (art.bottom - 18) * this.k;
      const locked = !isUnlocked(this.meta, name);
      sprite
        .setPosition(x, y)
        .setScale(scale)
        .setVisible(rect.bottom > 0 && art.top < h);
      sprite.setAlpha(selected ? (locked ? 0.72 : 1) : locked ? 0.38 : 0.68);
      sprite.setTint(locked ? 0x788294 : 0xffffff);
      if (selected) {
        this.selectedX = x;
        this.selectedY = y;
        this.ring
          ?.setPosition(x, y + 3 * this.k)
          .setSize((46 * scale) / 2, (16 * scale) / 2)
          .setStrokeStyle(1.5 * this.k, HEROES[name].color, 0.95)
          .setVisible(sprite.visible);
        this.arrow
          ?.setPosition(x, y - 25 * scale - 8 * this.k)
          .setScale(this.k)
          .setColor(`#${HEROES[name].color.toString(16).padStart(6, "0")}`)
          .setVisible(sprite.visible);
      }
    });
  };

  update(time: number): void {
    this.pad?.update();
    if (this.pad?.justPressed("left")) this.move(-1);
    if (this.pad?.justPressed("right")) this.move(1);
    if (this.shopOpen) {
      if (this.pad?.justPressed("up")) this.move(-1);
      if (this.pad?.justPressed("down")) this.move(1);
    }
    if (this.pad?.justPressed("a")) this.confirm();
    const pulse = this.reducedMotion?.matches ? 0 : Math.sin(time / 460);
    this.ring?.setScale(1 + pulse * 0.05);
    const selected = this.sprites[this.index];
    if (selected)
      this.arrow?.setPosition(
        this.selectedX,
        this.selectedY - 25 * selected.scaleY - 8 * this.k + pulse * 2 * this.k,
      );
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    // Native button activation owns Enter/Space; do not also descend behind it.
    if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " "))
      return;
    if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
    sfx.unlock();
    switch (event.code) {
      case "ArrowLeft":
      case "KeyA":
        this.move(-1);
        break;
      case "ArrowRight":
      case "KeyD":
        this.move(1);
        break;
      case "ArrowUp":
      case "KeyW":
        if (this.shopOpen) this.move(-1);
        break;
      case "ArrowDown":
      case "KeyS":
        if (this.shopOpen) this.move(1);
        break;
      case "Space":
      case "Enter":
      case "KeyJ":
        this.confirm();
        break;
      case "KeyU":
        this.buyUnlock();
        break;
      case "KeyC":
        this.toggleNet("coop");
        break;
      case "KeyV":
        this.toggleNet("vs");
        break;
      case "KeyM":
        this.toggleShop();
        break;
      case "Escape":
        if (this.shopOpen) this.toggleShop();
        break;
    }
  };

  private refresh(): void {
    this.view?.update({
      index: this.index,
      meta: this.meta,
      bestScore: loadBestScore(),
      net: this.net,
      code: this.code,
      shop: this.shopOpen ? { index: this.shopIndex } : null,
      coarse: isCoarse(),
    });
    this.layout();
  }

  private move(delta: number): void {
    this.view?.focusSelection();
    if (this.shopOpen)
      this.shopIndex = (this.shopIndex + delta + UPGRADES.length) % UPGRADES.length;
    else this.index = (this.index + delta + HERO_ORDER.length) % HERO_ORDER.length;
    sfx.select();
    this.refresh();
  }

  private pickHero(index: number): void {
    if (this.shopOpen) return;
    sfx.unlock();
    if (index === this.index) this.confirm();
    else {
      this.index = index;
      sfx.select();
      this.refresh();
    }
  }

  private go(): void {
    sfx.unlock();
    const name = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, name)) this.confirm();
    else this.buyUnlock();
  }

  private toggleShop(): void {
    sfx.unlock();
    this.shopOpen = !this.shopOpen;
    sfx.select();
    this.refresh();
  }

  private pickUpgrade(index: number): void {
    if (!this.shopOpen) return;
    if (this.shopIndex === index) this.buySelected();
    else {
      this.shopIndex = index;
      sfx.select();
      this.refresh();
    }
  }

  private buySelected(): void {
    const upgrade = UPGRADES[this.shopIndex];
    if (!upgrade) return;
    if (buyUpgrade(this.meta, upgrade.id)) {
      sfx.pickup();
      this.view?.announce(`${upgrade.name} upgraded.`);
    } else {
      sfx.hurt();
      this.view?.announce("Upgrade unavailable. Check shards and level.");
    }
    this.refresh();
  }

  private buyUnlock(): void {
    if (this.shopOpen) return;
    const name = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, name)) return;
    sfx.unlock();
    if (unlockHero(this.meta, name)) {
      sfx.pickup();
      this.view?.announce(`${HEROES[name].title} unlocked. Ready to descend.`);
      this.refresh();
    } else {
      sfx.hurt();
      this.view?.announce("More shards needed to unlock this warrior.");
    }
  }

  private toggleNet(mode: "coop" | "vs"): void {
    if (this.shopOpen) return;
    sfx.unlock();
    sfx.select();
    const url = new URL(location.href);
    if (this.net === mode) {
      this.net = "off";
      this.code = "";
      url.searchParams.delete("party");
      url.searchParams.delete("mode");
    } else {
      if (this.net === "off") this.code = randomCode();
      this.net = mode;
      url.searchParams.set("party", this.code);
      if (mode === "vs") url.searchParams.set("mode", "vs");
      else url.searchParams.delete("mode");
    }
    history.replaceState(null, "", url.toString());
    this.refresh();
  }

  /** Deliberate unlock never starts a run. Keyboard/controller confirm on a
   * locked hero remains a refusal, preserving the original purchase boundary. */
  private confirm(): void {
    if (this.shopOpen) return this.buySelected();
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (!isUnlocked(this.meta, hero)) {
      sfx.hurt();
      this.view?.announce("Unlock this warrior before descending.");
      return;
    }
    sfx.door();
    this.registry.set("hero", hero);
    this.registry.set("party", this.net !== "off" ? this.code : "");
    this.registry.set("mode", this.net === "vs" ? "vs" : "");
    this.registry.set("restartExpedition", this.net === "coop" && this.recap !== null);
    notifyGameStarted();
    this.scene.start("game", { hero });
  }
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++)
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return code;
}
