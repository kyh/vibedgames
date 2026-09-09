import type Phaser from "phaser";
import { Scene, Scenes } from "phaser";
import { notifyGameStarted, watchControlContext } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";
import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, HERO_ORIGIN_Y } from "../config";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import { readRunRecap } from "../data/run-recap";
import type { RunRecap } from "../data/run-recap";
import {
  buyUpgrade,
  isUnlocked,
  loadBestScore,
  loadMeta,
  unlockHero,
  UPGRADES,
} from "../data/meta";
import type { MetaState } from "../data/meta";
import { HubView } from "../hub/hub-view";
import { parseRoomCode, partyLink } from "../hub/party-link";
import { isCoarse } from "../sys/screen";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randomCode = (): string => {
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
};

/** Screen-space hub: the DOM (HubView) lays out and takes input, Phaser draws
 * the hero sprites over it. Only this scene resizes the game; the expedition
 * keeps its baked BASE_W/H camera. */
export class SelectScene extends Scene {
  private index = 0;
  private sprites: Phaser.GameObjects.Sprite[] = [];
  private showcase: Phaser.GameObjects.Sprite | null = null;
  private backdrop: Phaser.GameObjects.Image | null = null;
  private shade: Phaser.GameObjects.Rectangle | null = null;
  private view: HubView | null = null;
  private meta: MetaState = { bestDepth: 0, runs: 0, shards: 0, unlocked: [], upgrades: {} };
  private net: "off" | "coop" | "vs" = "off";
  private code = "";
  private shopOpen = false;
  private shopIndex = 0;
  private pad: PhysicalGamepad | null = null;
  private recap: RunRecap | null = null;
  private recapRoom: { code: string; mode: "coop" | "vs" } | null = null;
  private roomFull = false;
  private k = 1;

  constructor() {
    super("select");
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Phaser supplies untyped scene data; parse at this boundary.
  init(data: unknown): void {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Untrusted scene-entry payload, not game-domain state.
    const payload = typeof data === "object" && data !== null ? data : null;
    this.recap = payload && "recap" in payload ? readRunRecap(payload.recap) : null;
    this.roomFull = payload !== null && "roomFull" in payload && payload.roomFull === true;
    // Phaser retains old truthy scene data. Consume the receipt exactly once.
    this.sys.settings.data = {};
  }

  create(): void {
    this.meta = loadMeta();
    this.sprites = [];
    this.shopOpen = false;
    this.shopIndex = 0;
    const search = new URLSearchParams(location.search);
    const code = parseRoomCode(search.get("party") ?? "");
    this.code = code ?? "";
    this.net = "off";
    if (code) {
      this.net = search.get("mode") === "vs" ? "vs" : "coop";
    }
    this.recapRoom = this.recap && this.net !== "off" ? { code: this.code, mode: this.net } : null;
    this.syncRoomUrl();
    this.backdrop = this.add
      .image(0, 0, "env:backdrop")
      .setOrigin(0)
      .setTint(0x73_85_a8)
      .setAlpha(0.85);
    this.shade = this.add.rectangle(0, 0, 1, 1, 0x05_07_0b, 0.22).setOrigin(0);
    for (const name of HERO_ORDER) {
      const sprite = this.add
        .sprite(0, 0, name, firstFrame(this, name))
        .setOrigin(0.5, HERO_ORIGIN_Y);
      sprite.play(`${name}:idle`);
      this.sprites.push(sprite);
    }
    this.showcase = this.add
      .sprite(0, 0, "axion", firstFrame(this, "axion"))
      .setOrigin(0.5, HERO_ORIGIN_Y);
    this.view = new HubView(
      {
        forge: () => this.toggleShop(),
        go: () => this.go(),
        hero: (index) => this.pickHero(index),
        join: (room) => this.joinRoom(room),
        layout: this.layout,
        mode: (mode) => this.toggleNet(mode),
        offer: (index) => this.pickUpgrade(index),
      },
      this.recap,
    );
    this.pad = new PhysicalGamepad();
    this.pad.update();
    const kb = this.input.keyboard;
    kb?.on("keydown", this.keyDown);
    const unwatch = watchControlContext(() => this.refresh());
    window.addEventListener("resize", this.layout);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("resize", this.layout);
      unwatch();
      kb?.off("keydown", this.keyDown);
      this.pad?.destroy();
      this.pad = null;
      this.view?.destroy();
      this.view = null;
      // The expedition bakes BASE_W/H into its layout; hand it back before the descent.
      this.scale.setGameSize(BASE_W, BASE_H);
    });
    this.refresh();
    if (this.roomFull) {
      this.view.announce("Room full. Join another code or play Solo.");
    }
  }

  /** DOM stages determine sprite positions in CSS pixels; the render size
   * follows the window (capped at 720px tall) so sprites land on their stages. */
  private readonly layout = (): void => {
    const { view } = this;
    if (!view) {
      return;
    }
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.k = Math.min(1, 720 / h);
    const rw = Math.round(w * this.k);
    const rh = Math.round(h * this.k);
    if (this.scale.width !== rw || this.scale.height !== rh) {
      this.scale.setGameSize(rw, rh);
    }
    this.backdrop?.setDisplaySize(rw, rh);
    this.shade?.setDisplaySize(rw, rh);
    for (const [index, sprite] of this.sprites.entries()) {
      const node = view.heroes[index];
      const name = HERO_ORDER[index];
      if (!node || !name) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      const art = node.querySelector(".lf-hub-art")?.getBoundingClientRect();
      if (!art) {
        continue;
      }
      const selected = index === this.index;
      const scale = Math.min(rect.width / 32, art.height / 34, 2.4) * this.k;
      const x = (rect.left + rect.width / 2) * this.k;
      const y = (art.bottom - 5) * this.k;
      const locked = !isUnlocked(this.meta, name);
      sprite
        .setPosition(x, y)
        .setScale(scale)
        .setVisible(rect.bottom > 0 && art.top < h);
      let alpha = 0.9;
      if (selected) {
        alpha = 1;
      } else if (locked) {
        alpha = 0.68;
      }
      sprite.setAlpha(alpha);
      sprite.setTint(locked ? 0xaa_b2_c0 : 0xff_ff_ff);
    }
    const hero = HERO_ORDER[this.index] ?? "axion";
    const stage = view.showcase.getBoundingClientRect();
    const scale = Math.min(stage.width / 58, stage.height / 38, 8) * this.k;
    const visible = stage.bottom > 0 && stage.top < h;
    this.showcase
      ?.setPosition((stage.left + stage.width / 2) * this.k, (stage.bottom - 22) * this.k)
      .setScale(scale)
      .setAlpha(isUnlocked(this.meta, hero) ? 1 : 0.65)
      .setVisible(visible)
      .play(`${hero}:idle`, true);
  };

  update(): void {
    this.pad?.update();
    if (this.view?.blocksGameInput()) {
      return;
    }
    if (this.pad?.justPressed("left")) {
      this.move(-1);
    }
    if (this.pad?.justPressed("right")) {
      this.move(1);
    }
    if (this.shopOpen) {
      if (this.pad?.justPressed("up")) {
        this.move(-1);
      }
      if (this.pad?.justPressed("down")) {
        this.move(1);
      }
    }
    if (this.pad?.justPressed("a")) {
      this.confirm();
    }
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.repeat || this.view?.blocksGameInput()) {
      return;
    }
    // Native button activation owns Enter/Space; do not also descend behind it.
    if (
      event.target instanceof Element &&
      event.target.closest("button, summary") &&
      (event.key === "Enter" || event.key === " ")
    ) {
      return;
    }
    if (event.code.startsWith("Arrow") || event.code === "Space") {
      event.preventDefault();
    }
    sfx.unlock();
    this.keyActions.get(event.code)?.();
  };

  /** Up/Down and Escape only act inside the forge; every other key is global. */
  private readonly keyActions = new Map<string, () => void>(
    Object.entries({
      ArrowDown: () => this.shopMove(1),
      ArrowLeft: () => this.move(-1),
      ArrowRight: () => this.move(1),
      ArrowUp: () => this.shopMove(-1),
      Enter: () => this.confirm(),
      Escape: () => {
        if (this.shopOpen) {
          this.toggleShop();
        }
      },
      KeyA: () => this.move(-1),
      KeyC: () => this.toggleNet("coop"),
      KeyD: () => this.move(1),
      KeyJ: () => this.confirm(),
      KeyM: () => this.toggleShop(),
      KeyS: () => this.shopMove(1),
      KeyU: () => this.buyUnlock(),
      KeyV: () => this.toggleNet("vs"),
      KeyW: () => this.shopMove(-1),
      Space: () => this.confirm(),
    }),
  );

  private shopMove(delta: number): void {
    if (this.shopOpen) {
      this.move(delta);
    }
  }

  private refresh(): void {
    this.view?.update({
      bestScore: loadBestScore(),
      coarse: isCoarse(),
      code: this.code,
      index: this.index,
      inviteUrl: this.net === "off" ? "" : partyLink(location.href, this.code, this.net),
      meta: this.meta,
      net: this.net,
      shop: this.shopOpen ? { index: this.shopIndex } : null,
    });
    this.layout();
  }

  private move(delta: number): void {
    this.view?.focusSelection();
    if (this.shopOpen) {
      this.shopIndex = (this.shopIndex + delta + UPGRADES.length) % UPGRADES.length;
    } else {
      this.index = (this.index + delta + HERO_ORDER.length) % HERO_ORDER.length;
    }
    sfx.select();
    this.refresh();
  }

  private pickHero(index: number): void {
    if (this.shopOpen) {
      return;
    }
    sfx.unlock();
    if (index !== this.index) {
      this.index = index;
      sfx.select();
      this.refresh();
    }
  }

  private go(): void {
    sfx.unlock();
    const name = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, name)) {
      this.confirm();
    } else {
      this.buyUnlock();
    }
  }

  private toggleShop(): void {
    sfx.unlock();
    this.shopOpen = !this.shopOpen;
    sfx.select();
    this.refresh();
  }

  private pickUpgrade(index: number): void {
    if (!this.shopOpen) {
      return;
    }
    if (this.shopIndex === index) {
      this.buySelected();
    } else {
      this.shopIndex = index;
      sfx.select();
      this.refresh();
    }
  }

  private buySelected(): void {
    const upgrade = UPGRADES[this.shopIndex];
    if (!upgrade) {
      return;
    }
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
    if (this.shopOpen) {
      return;
    }
    const name = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, name)) {
      return;
    }
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

  private toggleNet(mode: "off" | "coop" | "vs"): void {
    if (this.shopOpen) {
      return;
    }
    sfx.unlock();
    sfx.select();
    if (mode === "off") {
      this.net = "off";
      this.code = "";
    } else {
      if (this.net === "off") {
        this.code = randomCode();
      }
      this.net = mode;
    }
    this.syncRoomUrl();
    this.view?.announce("");
    this.refresh();
  }

  private joinRoom(value: string): void {
    if (this.shopOpen || this.net === "off") {
      return;
    }
    const code = parseRoomCode(value);
    if (!code) {
      this.view?.announce("Enter a 4-character room code.");
      return;
    }
    this.code = code;
    this.syncRoomUrl();
    this.refresh();
    this.view?.announce("Room selected. Press Play to join.");
    this.view?.focusSelection();
  }

  private syncRoomUrl(): void {
    const url = new URL(location.href);
    if (this.net === "off") {
      url.searchParams.delete("party");
      url.searchParams.delete("mode");
      history.replaceState(null, "", url.toString());
    } else {
      history.replaceState(null, "", partyLink(location.href, this.code, this.net));
    }
  }

  /** Confirm never buys: a locked hero refuses, and U / the PLAY button's
   * UNLOCK label is the deliberate purchase path. */
  private confirm(): void {
    if (this.shopOpen) {
      return this.buySelected();
    }
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (!isUnlocked(this.meta, hero)) {
      sfx.hurt();
      this.view?.announce("Unlock this warrior before descending.");
      return;
    }
    sfx.door();
    this.registry.set("hero", hero);
    this.registry.set("party", this.net === "off" ? "" : this.code);
    this.registry.set("mode", this.net === "vs" ? "vs" : "");
    this.registry.set(
      "restartExpedition",
      this.net === "coop" && this.recapRoom?.mode === "coop" && this.recapRoom.code === this.code,
    );
    notifyGameStarted();
    this.scene.start("game", { hero });
  }
}
