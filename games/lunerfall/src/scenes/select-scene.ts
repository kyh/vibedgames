import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, HERO_ORIGIN_Y } from "../config";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import {
  buyUpgrade,
  isUnlocked,
  loadMeta,
  type MetaState,
  UNLOCK_COST,
  unlockHero,
  UPGRADES,
  upgradeLevel,
} from "../data/meta";

// The hub: pick a warrior, spend shards to unlock the locked ones, then descend.
// Best depth + shard bank persist across runs via localStorage.
export class SelectScene extends Phaser.Scene {
  private index = 0;
  private rowY = 0;
  private sprites: Phaser.GameObjects.Sprite[] = [];
  private selGlow!: Phaser.GameObjects.Ellipse;
  private selRing!: Phaser.GameObjects.Ellipse;
  private selArrow!: Phaser.GameObjects.Text;
  private locks: Phaser.GameObjects.Text[] = [];
  private title!: Phaser.GameObjects.Text;
  private blurb!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private bank!: Phaser.GameObjects.Text;
  private coopText!: Phaser.GameObjects.Text;
  private meta: MetaState = { shards: 0, unlocked: [], bestDepth: 0, runs: 0, upgrades: {} };
  private coop = false;
  private code = "";
  // Moon Forge — the permanent-upgrade shop, a modal panel over the hero picker.
  private shopOpen = false;
  private shopIndex = 0;
  private shopPanel!: Phaser.GameObjects.Container;
  private shopRows: Phaser.GameObjects.Text[] = [];
  private shopShards!: Phaser.GameObjects.Text;

  constructor() {
    super("select");
  }

  create() {
    this.meta = loadMeta();
    // A shared ?party=CODE link drops the joiner straight into co-op mode.
    const joinCode = new URLSearchParams(location.search).get("party");
    if (joinCode) {
      this.coop = true;
      this.code = joinCode.toUpperCase();
    }
    this.add.rectangle(0, 0, BASE_W, BASE_H, COLORS.bgDeep).setOrigin(0);
    this.add
      .image(0, 0, "env:backdrop")
      .setOrigin(0)
      .setDisplaySize(BASE_W, BASE_H)
      .setTint(0x7385a8)
      .setAlpha(0.5);
    this.add.rectangle(0, BASE_H * 0.62, BASE_W, BASE_H * 0.38, COLORS.bgDeep, 0.55).setOrigin(0);
    this.add
      .text(BASE_W / 2, 34, "LUNERFALL", {
        fontFamily: "monospace",
        fontSize: "22px",
        color: "#34e5c8",
      })
      .setOrigin(0.5);
    this.add
      .text(BASE_W / 2, 58, "CHOOSE YOUR WARRIOR", {
        fontFamily: "monospace",
        fontSize: "9px",
        color: "#8b95a1",
      })
      .setOrigin(0.5);
    this.bank = this.add
      .text(BASE_W - 8, 8, "", { fontFamily: "monospace", fontSize: "8px", color: "#ffd15c" })
      .setOrigin(1, 0);

    const rowY = BASE_H * 0.56;
    this.rowY = rowY;
    const n = HERO_ORDER.length;

    // Selection highlight — a soft pedestal glow, a crisp pulsing ring, and a
    // bobbing pointer above, all recoloured to the current pick in refresh() so
    // the highlighted warrior reads clearly even when it's a dimmed locked one.
    this.selGlow = this.add.ellipse(0, rowY + 3, 50, 18, 0xffffff, 0.22).setDepth(-1);
    this.selRing = this.add
      .ellipse(0, rowY + 3, 46, 16, 0xffffff, 0)
      .setStrokeStyle(1.5, 0xffffff, 0.95)
      .setDepth(5);
    this.selArrow = this.add
      .text(0, rowY - 42, "▼", { fontFamily: "monospace", fontSize: "11px", color: "#ffffff" })
      .setOrigin(0.5)
      .setDepth(5);
    this.tweens.add({
      targets: this.selRing,
      scaleX: 1.1,
      scaleY: 1.1,
      duration: 720,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.tweens.add({
      targets: this.selArrow,
      y: rowY - 46,
      duration: 620,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    HERO_ORDER.forEach((name, i) => {
      const x = ((i + 1) / (n + 1)) * BASE_W;
      const spr = this.add
        .sprite(x, rowY, name, firstFrame(this, name))
        .setOrigin(0.5, HERO_ORIGIN_Y)
        .setScale(1.4);
      spr.play(`${name}:idle`);
      const lock = this.add
        .text(x, rowY - 26, "", { fontFamily: "monospace", fontSize: "8px", color: "#ffd15c" })
        .setOrigin(0.5);
      this.sprites.push(spr);
      this.locks.push(lock);
    });

    this.title = this.add
      .text(BASE_W / 2, rowY + 34, "", {
        fontFamily: "monospace",
        fontSize: "13px",
        color: "#f4f7fb",
      })
      .setOrigin(0.5);
    this.blurb = this.add
      .text(BASE_W / 2, rowY + 52, "", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#b8c1cc",
      })
      .setOrigin(0.5);
    this.hint = this.add
      .text(BASE_W / 2, BASE_H - 16, "", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#59636f",
      })
      .setOrigin(0.5);
    this.coopText = this.add
      .text(BASE_W / 2, BASE_H - 30, "", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#34e5c8",
      })
      .setOrigin(0.5);

    const kb = this.input.keyboard;
    kb?.on("keydown-LEFT", () => this.move(-1));
    kb?.on("keydown-A", () => this.move(-1));
    kb?.on("keydown-RIGHT", () => this.move(1));
    kb?.on("keydown-D", () => this.move(1));
    kb?.on("keydown-SPACE", () => this.confirm());
    kb?.on("keydown-ENTER", () => this.confirm());
    kb?.on("keydown-J", () => this.confirm());
    kb?.on("keydown-U", () => this.buyUnlock());
    kb?.on("keydown-C", () => this.toggleCoop());
    kb?.on("keydown-M", () => this.toggleShop());
    kb?.on("keydown-ESC", () => this.shopOpen && this.toggleShop());
    kb?.on("keydown-UP", () => this.shopOpen && this.shopMove(-1));
    kb?.on("keydown-W", () => this.shopOpen && this.shopMove(-1));
    kb?.on("keydown-DOWN", () => this.shopOpen && this.shopMove(1));
    kb?.on("keydown-S", () => this.shopOpen && this.shopMove(1));
    kb?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());

    this.buildShop();
    this.refresh();
  }

  private move(d: number) {
    if (this.shopOpen) return this.shopMove(d);
    this.index = (this.index + d + HERO_ORDER.length) % HERO_ORDER.length;
    sfx.select();
    this.refresh();
  }

  // ── Moon Forge (permanent upgrades) ──────────────────────────────────────
  private buildShop() {
    const panel = this.add.container(0, 0).setDepth(50).setVisible(false);
    const dim = this.add.rectangle(0, 0, BASE_W, BASE_H, 0x05070b, 0.84).setOrigin(0);
    const title = this.add
      .text(BASE_W / 2, 32, "MOON FORGE", { fontFamily: "monospace", fontSize: "16px", color: "#34e5c8" })
      .setOrigin(0.5);
    const sub = this.add
      .text(BASE_W / 2, 52, "permanent upgrades — carry into every run", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#8b95a1",
      })
      .setOrigin(0.5);
    this.shopShards = this.add
      .text(BASE_W / 2, 68, "", { fontFamily: "monospace", fontSize: "9px", color: "#ffd15c" })
      .setOrigin(0.5);
    panel.add([dim, title, sub, this.shopShards]);
    const top = 98;
    this.shopRows = UPGRADES.map((_, i) => {
      const t = this.add
        .text(BASE_W / 2, top + i * 22, "", { fontFamily: "monospace", fontSize: "10px", color: "#b8c1cc" })
        .setOrigin(0.5);
      panel.add(t);
      return t;
    });
    const hint = this.add
      .text(BASE_W / 2, BASE_H - 20, "↑ ↓  select      ENTER  buy      M  close", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#59636f",
      })
      .setOrigin(0.5);
    panel.add(hint);
    this.shopPanel = panel;
  }

  private toggleShop() {
    this.shopOpen = !this.shopOpen;
    this.shopPanel.setVisible(this.shopOpen);
    sfx.select();
    if (this.shopOpen) this.refreshShop();
  }

  private shopMove(d: number) {
    this.shopIndex = (this.shopIndex + d + UPGRADES.length) % UPGRADES.length;
    sfx.select();
    this.refreshShop();
  }

  private buySelected() {
    const u = UPGRADES[this.shopIndex];
    if (!u) return;
    if (buyUpgrade(this.meta, u.id)) {
      sfx.pickup();
      this.cameras.main.flash(160, 52, 229, 200);
    } else {
      sfx.hurt();
      this.cameras.main.shake(120, 0.005);
    }
    this.refreshShop();
    this.bank.setText(`✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}`);
  }

  private refreshShop() {
    this.shopShards.setText(`✦ ${this.meta.shards} shards`);
    UPGRADES.forEach((u, i) => {
      const lvl = upgradeLevel(this.meta, u.id);
      const pips = "●".repeat(lvl) + "○".repeat(u.max - lvl);
      const maxed = lvl >= u.max;
      const cost = maxed ? "MAX" : `${u.cost(lvl)} ✦`;
      const sel = i === this.shopIndex;
      const afford = !maxed && this.meta.shards >= u.cost(lvl);
      this.shopRows[i]
        ?.setText(`${sel ? "▸ " : "  "}${u.name.padEnd(11)} ${pips}  ${u.desc}   ${cost}`)
        .setColor(sel ? "#34e5c8" : maxed ? "#6b7480" : afford ? "#d8dee6" : "#8b7a5a");
    });
  }

  private refresh() {
    const name = HERO_ORDER[this.index];
    if (!name) return;
    const def = HEROES[name];
    this.sprites.forEach((s, i) => {
      const heroName = HERO_ORDER[i];
      const locked = heroName ? !isUnlocked(this.meta, heroName) : false;
      s.setScale(i === this.index ? 2 : 1.3);
      s.setAlpha(i === this.index ? (locked ? 0.7 : 1) : locked ? 0.28 : 0.6);
      s.setTint(locked ? 0x2a3340 : 0xffffff);
    });
    const sel = this.sprites[this.index];
    if (sel) {
      const hex = `#${def.color.toString(16).padStart(6, "0")}`;
      this.selGlow.setPosition(sel.x, this.rowY + 3).setFillStyle(def.color, 0.22);
      this.selRing.setPosition(sel.x, this.rowY + 3).setStrokeStyle(1.5, def.color, 0.95);
      this.selArrow.setX(sel.x).setColor(hex); // keep the bobbing y from its tween
    }
    this.locks.forEach((l, i) => {
      const hn = HERO_ORDER[i];
      l.setText(hn && !isUnlocked(this.meta, hn) ? `🔒 ${UNLOCK_COST[hn]}` : "");
    });
    this.title.setText(def.title).setColor(`#${def.color.toString(16).padStart(6, "0")}`);
    this.blurb.setText(def.blurb);

    const unlocked = isUnlocked(this.meta, name);
    const go = this.coop ? "join co-op" : "descend";
    this.hint.setText(
      unlocked
        ? `← →  choose    SPACE / J  ${go}    C  co-op    M  forge`
        : `← →  choose    U  unlock (${UNLOCK_COST[name]} ✦)    M  forge`,
    );
    this.coopText.setText(
      this.coop ? `CO-OP ${this.code}  ·  share this page's URL, then both press SPACE` : "",
    );
    this.bank.setText(`✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}`);
  }

  // Host a co-op room: mint a code, put it in the URL so it's shareable, and flip
  // into co-op mode. (A joiner already arrived with ?party set.)
  private toggleCoop() {
    if (this.shopOpen) return;
    sfx.select();
    if (this.coop) {
      this.coop = false;
      this.code = "";
    } else {
      this.coop = true;
      this.code = randomCode();
      const url = new URL(location.href);
      url.searchParams.set("party", this.code);
      history.replaceState(null, "", url.toString());
    }
    this.refresh();
  }

  // Start a run — only ever with an already-unlocked hero. A locked hero can't
  // be picked here; it must be deliberately bought first (buyUnlock, the U key),
  // so mashing "go" on the death screen never silently spends your shards.
  private confirm() {
    if (this.shopOpen) return this.buySelected();
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (!isUnlocked(this.meta, hero)) {
      sfx.hurt();
      this.cameras.main.shake(140, 0.006);
      return;
    }
    sfx.door();
    this.registry.set("hero", hero);
    this.registry.set("party", this.coop ? this.code : "");
    this.scene.start("game", { hero });
  }

  // Deliberate hub purchase: spend shards to unlock the highlighted hero. Never
  // starts a run — you pick it with a second, explicit "descend" press.
  private buyUnlock() {
    if (this.shopOpen) return;
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, hero)) return;
    sfx.unlock();
    if (unlockHero(this.meta, hero)) {
      sfx.pickup();
      this.cameras.main.flash(200, 52, 229, 200);
      this.refresh();
    } else {
      sfx.hurt();
      this.cameras.main.shake(140, 0.006);
    }
  }
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(): string {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return c;
}
