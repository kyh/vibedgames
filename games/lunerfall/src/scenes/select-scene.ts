import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, HERO_ORIGIN_Y } from "../config";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import {
  buyUpgrade,
  isUnlocked,
  loadBestScore,
  loadMeta,
  type MetaState,
  UNLOCK_COST,
  unlockHero,
  UPGRADES,
  upgradeLevel,
} from "../data/meta";
import { gameInset, isCoarse } from "../sys/screen";

// A tappable pill: stroke rect (the hit target) + centred label.
type TapBtn = { rect: Phaser.GameObjects.Rectangle; txt: Phaser.GameObjects.Text };

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
  // Online play: off, co-op descent (C), or versus duel (V). One code serves both.
  private net: "off" | "coop" | "vs" = "off";
  private code = "";
  // Moon Forge — the permanent-upgrade shop, a modal panel over the hero picker.
  private shopOpen = false;
  private shopIndex = 0;
  private shopPanel!: Phaser.GameObjects.Container;
  private shopRows: Phaser.GameObjects.Text[] = [];
  private shopShards!: Phaser.GameObjects.Text;
  // Touch UI (created only on coarse-pointer devices; undefined on desktop).
  private touch = false;
  private goBtn?: TapBtn;
  private coopBtn?: TapBtn;
  private vsBtn?: TapBtn;
  private soundBtn?: TapBtn;

  constructor() {
    super("select");
  }

  create() {
    this.meta = loadMeta();
    this.touch = isCoarse();
    // A shared ?party=CODE link drops the joiner straight into online mode —
    // co-op by default, versus when the link is flagged &mode=vs.
    this.net = "off";
    this.code = "";
    // Scene instances persist across start/stop — never let a previous visit's
    // (destroyed) objects linger in these lists.
    this.sprites = [];
    this.locks = [];
    const search = new URLSearchParams(location.search);
    const joinCode = search.get("party");
    if (joinCode) {
      this.net = search.get("mode") === "vs" ? "vs" : "coop";
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
      // Full-column tap target per hero (works for mouse too): tap selects,
      // tapping the already-selected hero descends (SPACE equivalent).
      this.add
        .zone(x, rowY - 25, BASE_W / (n + 1), 110)
        .setInteractive()
        .on("pointerdown", () => {
          if (this.shopOpen) return;
          if (i === this.index) this.confirm();
          else {
            this.index = i;
            sfx.select();
            this.refresh();
          }
        });
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
    this.buildTouchUi();

    const kb = this.input.keyboard;
    kb?.on("keydown-LEFT", () => this.move(-1));
    kb?.on("keydown-A", () => this.move(-1));
    kb?.on("keydown-RIGHT", () => this.move(1));
    kb?.on("keydown-D", () => this.move(1));
    kb?.on("keydown-SPACE", () => this.confirm());
    kb?.on("keydown-ENTER", () => this.confirm());
    kb?.on("keydown-J", () => this.confirm());
    kb?.on("keydown-U", () => this.buyUnlock());
    kb?.on("keydown-C", () => this.toggleNet("coop"));
    kb?.on("keydown-V", () => this.toggleNet("vs"));
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

  // ── touch UI (coarse-pointer devices only; desktop keeps the key hints) ──
  private tapBtn(x: number, y: number, w: number, h: number, onTap: () => void): TapBtn {
    const rect = this.add
      .rectangle(x, y, w, h, 0x0b0e14, 0.72)
      .setStrokeStyle(1, 0x59636f, 0.9)
      .setInteractive({ useHandCursor: true });
    rect.on("pointerdown", onTap);
    const txt = this.add
      .text(x, y, "", { fontFamily: "monospace", fontSize: "9px", color: "#d8dee6" })
      .setOrigin(0.5);
    return { rect, txt };
  }

  // Tap targets replacing the keyboard chords: GO/UNLOCK · FORGE · CO-OP ·
  // VERSUS along the bottom edge, sound toggle top-left (phones have no M key
  // — without this, touch players get permanent silence). Labels/colors are
  // kept current by refresh().
  private buildTouchUi() {
    this.goBtn = undefined;
    this.coopBtn = undefined;
    this.vsBtn = undefined;
    this.soundBtn = undefined;
    if (!this.touch) return;
    const ins = gameInset(this);
    this.bank.setPosition(BASE_W - 8 - ins.right, 8 + ins.top);
    const y = BASE_H - 20 - ins.bottom;
    this.hint.setY(y - 25);
    this.coopText.setY(y - 36);
    const widths = [96, 58, 58, 66];
    const gap = 8;
    const total = widths.reduce((a, b) => a + b) + gap * (widths.length - 1);
    let x = BASE_W / 2 - total / 2;
    const centers = widths.map((w) => {
      const c = x + w / 2;
      x += w + gap;
      return c;
    });
    this.goBtn = this.tapBtn(centers[0] ?? 0, y, widths[0] ?? 0, 26, () => {
      if (this.shopOpen) return;
      const hero = HERO_ORDER[this.index] ?? "axion";
      if (isUnlocked(this.meta, hero)) this.confirm();
      else this.buyUnlock();
    });
    const forge = this.tapBtn(centers[1] ?? 0, y, widths[1] ?? 0, 26, () => this.toggleShop());
    forge.txt.setText("FORGE");
    this.coopBtn = this.tapBtn(centers[2] ?? 0, y, widths[2] ?? 0, 26, () =>
      this.toggleNet("coop"),
    );
    this.coopBtn.txt.setText("CO-OP");
    this.vsBtn = this.tapBtn(centers[3] ?? 0, y, widths[3] ?? 0, 26, () => this.toggleNet("vs"));
    this.vsBtn.txt.setText("VERSUS");
    const snd = this.tapBtn(24 + ins.left, 20 + ins.top, 30, 30, () => {
      sfx.toggleMute();
      this.soundBtn?.txt.setText(sfx.muted ? "×" : "♪");
    });
    snd.txt.setText(sfx.muted ? "×" : "♪");
    this.soundBtn = snd;
  }

  // ── Moon Forge (permanent upgrades) ──────────────────────────────────────
  private buildShop() {
    const panel = this.add.container(0, 0).setDepth(50).setVisible(false);
    // Tapping the dim backdrop (anywhere off a row) closes the panel; the rows
    // sit above it so their taps win the hit test.
    const dim = this.add.rectangle(0, 0, BASE_W, BASE_H, 0x05070b, 0.84).setOrigin(0);
    dim.setInteractive().on("pointerdown", () => this.shopOpen && this.toggleShop());
    const title = this.add
      .text(BASE_W / 2, 32, "MOON FORGE", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#34e5c8",
      })
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
        .text(BASE_W / 2, top + i * 22, "", {
          fontFamily: "monospace",
          fontSize: "10px",
          color: "#b8c1cc",
        })
        .setOrigin(0.5);
      // Tap a row to select it; tap the selected row to buy (two taps so a
      // stray touch never spends shards). Padding fattens the hit target.
      t.setPadding(30, 5, 30, 5)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => {
          if (!this.shopOpen) return;
          if (this.shopIndex === i) this.buySelected();
          else {
            this.shopIndex = i;
            sfx.select();
            this.refreshShop();
          }
        });
      panel.add(t);
      return t;
    });
    const close = this.add
      .text(BASE_W - 18, 16, "✕", { fontFamily: "monospace", fontSize: "13px", color: "#8b95a1" })
      .setOrigin(0.5)
      .setPadding(8, 8, 8, 8)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.shopOpen && this.toggleShop());
    panel.add(close);
    const hint = this.add
      .text(
        BASE_W / 2,
        BASE_H - 20,
        this.touch
          ? "tap a row to select — tap again to buy — ✕ closes"
          : "↑ ↓  select      ENTER  buy      M  close",
        {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#59636f",
        },
      )
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
    this.bank.setText(
      `✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}   ★ ${loadBestScore()}`,
    );
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
    const go =
      this.net === "coop" ? "join co-op" : this.net === "vs" ? "enter the duel" : "descend";
    const goLabel = !unlocked
      ? `UNLOCK ${UNLOCK_COST[name]} ✦`
      : this.net === "coop"
        ? "JOIN CO-OP"
        : this.net === "vs"
          ? "DUEL"
          : "DESCEND";
    this.hint.setText(
      this.touch
        ? unlocked
          ? `tap a warrior — tap again or ${goLabel} to go`
          : "tap UNLOCK to free this warrior"
        : unlocked
          ? `← →  choose    SPACE / J  ${go}    C  co-op    V  versus    M  forge`
          : `← →  choose    U  unlock (${UNLOCK_COST[name]} ✦)    M  forge`,
    );
    if (this.goBtn) {
      this.goBtn.txt.setText(goLabel).setColor(unlocked ? "#34e5c8" : "#ffd15c");
      this.goBtn.rect.setStrokeStyle(1, unlocked ? 0x34e5c8 : 0xffd15c, 0.9);
    }
    if (this.coopBtn) {
      this.coopBtn.rect.setStrokeStyle(1, this.net === "coop" ? 0x34e5c8 : 0x59636f, 0.9);
      this.coopBtn.txt.setColor(this.net === "coop" ? "#34e5c8" : "#8b95a1");
    }
    if (this.vsBtn) {
      this.vsBtn.rect.setStrokeStyle(1, this.net === "vs" ? 0xe83fa0 : 0x59636f, 0.9);
      this.vsBtn.txt.setColor(this.net === "vs" ? "#e83fa0" : "#8b95a1");
    }
    const bothDo = this.touch ? `tap ${this.net === "vs" ? "DUEL" : "JOIN CO-OP"}` : "press SPACE";
    this.coopText
      .setText(
        this.net === "coop"
          ? `CO-OP ${this.code}  ·  share this page's URL, then both ${bothDo}`
          : this.net === "vs"
            ? `⚔ VERSUS ${this.code}  ·  share this page's URL, then both ${bothDo}  ·  first to 3 rounds`
            : "",
      )
      .setColor(this.net === "vs" ? "#e83fa0" : "#34e5c8");
    this.bank.setText(
      `✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}   ★ ${loadBestScore()}`,
    );
  }

  // Host an online room: mint a code and put it (plus the mode flag) in the URL
  // so it's shareable. Pressing the same key again turns it off; the other key
  // switches modes and keeps the code. (A joiner already arrived with ?party.)
  private toggleNet(mode: "coop" | "vs") {
    if (this.shopOpen) return;
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
    this.registry.set("party", this.net !== "off" ? this.code : "");
    this.registry.set("mode", this.net === "vs" ? "vs" : "");
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
