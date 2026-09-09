import type Phaser from "phaser";
import { Scene, Scenes } from "phaser";
import { controlGroups, notifyGameStarted, watchControlContext } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, HERO_ORIGIN_Y } from "../config";
import { CONTROLS } from "../controls";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import {
  buyUpgrade,
  isUnlocked,
  loadBestScore,
  loadMeta,
  UNLOCK_COST,
  unlockHero,
  UPGRADES,
  upgradeLevel,
} from "../data/meta";
import type { MetaState } from "../data/meta";
import { gameInset, isCoarse, touchHudBand } from "../sys/screen";

// A tappable pill: stroke rect (the hit target) + centred label.
interface TapBtn {
  rect: Phaser.GameObjects.Rectangle;
  txt: Phaser.GameObjects.Text;
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randomCode = (): string => {
  let c = "";
  for (let i = 0; i < 4; i += 1) {
    c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return c;
};

type NetMode = "off" | "coop" | "vs";

const shopRowColor = (sel: boolean, maxed: boolean, afford: boolean): string => {
  if (sel) {
    return "#34e5c8";
  }
  if (maxed) {
    return "#6b7480";
  }
  return afford ? "#d8dee6" : "#8b7a5a";
};

const heroAlpha = (selected: boolean, locked: boolean): number => {
  if (selected) {
    return locked ? 0.7 : 1;
  }
  return locked ? 0.28 : 0.6;
};

const goVerb = (net: NetMode): string => {
  if (net === "coop") {
    return "join co-op";
  }
  return net === "vs" ? "enter the duel" : "descend";
};

const goLabelFor = (net: NetMode, unlocked: boolean, cost: number): string => {
  if (!unlocked) {
    return `UNLOCK ${cost} ✦`;
  }
  if (net === "coop") {
    return "JOIN CO-OP";
  }
  return net === "vs" ? "DUEL" : "DESCEND";
};

const hintFor = (
  touch: boolean,
  unlocked: boolean,
  go: string,
  goLabel: string,
  cost: number,
): string => {
  if (touch) {
    return unlocked
      ? `tap a warrior — tap again or ${goLabel} to go`
      : "tap UNLOCK to free this warrior";
  }
  return unlocked
    ? `← →  choose    SPACE / J  ${go}    C  co-op    V  versus    M  forge`
    : `← →  choose    U  unlock (${cost} ✦)    M  forge`;
};

const lobbyLine = (net: NetMode, code: string, bothDo: string): string => {
  if (net === "coop") {
    return `CO-OP ${code}  ·  share this page's URL, then both ${bothDo}`;
  }
  if (net === "vs") {
    return `⚔ VERSUS ${code}  ·  share this page's URL, then both ${bothDo}  ·  first to 3 rounds`;
  }
  return "";
};

// The hub: pick a warrior, spend shards to unlock the locked ones, then descend.
// Best depth + shard bank persist across runs via localStorage.
export class SelectScene extends Scene {
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
  private meta: MetaState = { bestDepth: 0, runs: 0, shards: 0, unlocked: [], upgrades: {} };
  // Online play: off, co-op descent (C), or versus duel (V). One code serves both.
  private net: NetMode = "off";
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
  // Physical controller on the hub: d-pad cycles, A confirms (see update()).
  private pad = new PhysicalGamepad();
  private unwatchControls: (() => void) | null = null;
  // Controls block under the subtitle — the pause panel's gold pixel keycaps
  // and method dividers, mirrored in Phaser objects. Rebuilt when the visible
  // groups change (pad connect/disconnect re-runs refresh()).
  private controlsBlock: Phaser.GameObjects.Container | null = null;
  private controlsSig = "";

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
    this.controlsBlock = null;
    this.controlsSig = "";
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
      .setTint(0x73_85_a8)
      .setAlpha(0.5);
    this.add.rectangle(0, BASE_H * 0.62, BASE_W, BASE_H * 0.38, COLORS.bgDeep, 0.55).setOrigin(0);
    this.add
      .text(BASE_W / 2, 34, "LUNERFALL", {
        color: "#34e5c8",
        fontFamily: "monospace",
        fontSize: "22px",
      })
      .setOrigin(0.5);
    this.add
      .text(BASE_W / 2, 58, "CHOOSE YOUR WARRIOR", {
        color: "#8b95a1",
        fontFamily: "monospace",
        fontSize: "9px",
      })
      .setOrigin(0.5);
    this.bank = this.add
      .text(BASE_W - 8, 8, "", { color: "#ffd15c", fontFamily: "monospace", fontSize: "8px" })
      .setOrigin(1, 0);

    const rowY = BASE_H * 0.56;
    this.rowY = rowY;
    const n = HERO_ORDER.length;

    // Selection highlight — a soft pedestal glow, a crisp pulsing ring, and a
    // bobbing pointer above, all recoloured to the current pick in refresh() so
    // the highlighted warrior reads clearly even when it's a dimmed locked one.
    this.selGlow = this.add.ellipse(0, rowY + 3, 50, 18, 0xff_ff_ff, 0.22).setDepth(-1);
    this.selRing = this.add
      .ellipse(0, rowY + 3, 46, 16, 0xff_ff_ff, 0)
      .setStrokeStyle(1.5, 0xff_ff_ff, 0.95)
      .setDepth(5);
    this.selArrow = this.add
      .text(0, rowY - 42, "▼", { color: "#ffffff", fontFamily: "monospace", fontSize: "11px" })
      .setOrigin(0.5)
      .setDepth(5);
    this.tweens.add({
      duration: 720,
      ease: "Sine.easeInOut",
      repeat: -1,
      scaleX: 1.1,
      scaleY: 1.1,
      targets: this.selRing,
      yoyo: true,
    });
    this.tweens.add({
      duration: 620,
      ease: "Sine.easeInOut",
      repeat: -1,
      targets: this.selArrow,
      y: rowY - 46,
      yoyo: true,
    });

    this.buildRoster(rowY, n);

    this.title = this.add
      .text(BASE_W / 2, rowY + 34, "", {
        color: "#f4f7fb",
        fontFamily: "monospace",
        fontSize: "13px",
      })
      .setOrigin(0.5);
    this.blurb = this.add
      .text(BASE_W / 2, rowY + 52, "", {
        color: "#b8c1cc",
        fontFamily: "monospace",
        fontSize: "8px",
      })
      .setOrigin(0.5);
    this.hint = this.add
      .text(BASE_W / 2, BASE_H - 16, "", {
        color: "#59636f",
        fontFamily: "monospace",
        fontSize: "8px",
      })
      .setOrigin(0.5);
    this.coopText = this.add
      .text(BASE_W / 2, BASE_H - 30, "", {
        color: "#34e5c8",
        fontFamily: "monospace",
        fontSize: "8px",
      })
      .setOrigin(0.5);
    this.buildTouchUi();

    this.bindKeys();
    this.input.once("pointerdown", () => sfx.unlock());

    this.buildShop();
    this.refresh();

    // Re-render the hints when a pad appears/vanishes while the hub is up.
    // Scene instances persist across start/stop — drop any previous visit's
    // watcher before subscribing, and unsubscribe on shutdown.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => this.refresh());
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.unwatchControls?.();
      this.unwatchControls = null;
    });
    // Prime pad state so a button held across the scene change (A just left a
    // versus match, say) doesn't read as a fresh press on the hub's first frame.
    this.pad.update();
  }

  // Physical controller mirrors the hub keys: d-pad ←/→ cycle (move() redirects
  // to the forge cursor while the shop is open, like A/D), d-pad ↑/↓ move the
  // forge cursor, A confirms (buy while the shop is open, like SPACE).
  update() {
    this.pad.update();
    if (this.pad.justPressed("left")) {
      this.move(-1);
    }
    if (this.pad.justPressed("right")) {
      this.move(1);
    }
    if (this.shopOpen) {
      if (this.pad.justPressed("up")) {
        this.shopMove(-1);
      }
      if (this.pad.justPressed("down")) {
        this.shopMove(1);
      }
    }
    if (this.pad.justPressed("a")) {
      this.confirm();
    }
  }

  private move(d: number) {
    if (this.shopOpen) {
      return this.shopMove(d);
    }
    this.index = (this.index + d + HERO_ORDER.length) % HERO_ORDER.length;
    sfx.select();
    this.refresh();
  }

  // ── touch UI (coarse-pointer devices only; desktop keeps the key hints) ──
  private tapBtn(x: number, y: number, w: number, h: number, onTap: () => void): TapBtn {
    const rect = this.add
      .rectangle(x, y, w, h, 0x0b_0e_14, 0.72)
      .setStrokeStyle(1, 0x59_63_6f, 0.9)
      .setInteractive({ useHandCursor: true });
    rect.on("pointerdown", onTap);
    const txt = this.add
      .text(x, y, "", { color: "#d8dee6", fontFamily: "monospace", fontSize: "9px" })
      .setOrigin(0.5);
    return { rect, txt };
  }

  // Tap targets replacing the keyboard chords: GO/UNLOCK · FORGE · CO-OP ·
  // VERSUS along the bottom edge. (Sound lives in the DOM cluster, ../touch-hud.)
  // Labels/colors are kept current by refresh().
  private buildTouchUi() {
    this.goBtn = undefined;
    this.coopBtn = undefined;
    this.vsBtn = undefined;
    if (!this.touch) {
      return;
    }
    const ins = gameInset(this);
    // The pause/mute cluster owns the top-right corner on a phone; the hub's
    // own top-left is empty, so the shard bank moves there rather than fight it.
    this.bank.setOrigin(0, 0).setPosition(8 + ins.left, 8 + ins.top);
    const y = BASE_H - 20 - ins.bottom;
    // The copy above the buttons is one stack laid out UPWARD from them, title
    // included: a home-indicator inset lifts the whole block. Anchoring the
    // blurb to the hero row instead left the lifted lines printing through it.
    const line = 11;
    this.hint.setY(y - 25);
    this.coopText.setY(y - 25 - line);
    this.blurb.setY(y - 25 - line * 2);
    this.title.setY(Math.min(this.rowY + 34, y - 25 - line * 2 - 13));
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
      if (this.shopOpen) {
        return;
      }
      const hero = HERO_ORDER[this.index] ?? "axion";
      if (isUnlocked(this.meta, hero)) {
        this.confirm();
      } else {
        this.buyUnlock();
      }
    });
    const forge = this.tapBtn(centers[1] ?? 0, y, widths[1] ?? 0, 26, () => this.toggleShop());
    forge.txt.setText("FORGE");
    this.coopBtn = this.tapBtn(centers[2] ?? 0, y, widths[2] ?? 0, 26, () =>
      this.toggleNet("coop"),
    );
    this.coopBtn.txt.setText("CO-OP");
    this.vsBtn = this.tapBtn(centers[3] ?? 0, y, widths[3] ?? 0, 26, () => this.toggleNet("vs"));
    this.vsBtn.txt.setText("VERSUS");
  }

  // ── Moon Forge (permanent upgrades) ──────────────────────────────────────
  private buildShop() {
    const ins = gameInset(this);
    const panel = this.add.container(0, 0).setDepth(50).setVisible(false);
    // Tapping the dim backdrop (anywhere off a row) closes the panel; the rows
    // sit above it so their taps win the hit test. Near-opaque: the hub behind
    // is all centred text and chips, which at phone size reads through a
    // lighter scrim as noise printed over the upgrade rows.
    const dim = this.add.rectangle(0, 0, BASE_W, BASE_H, 0x05_07_0b, 0.96).setOrigin(0);
    dim.setInteractive().on("pointerdown", () => this.shopOpen && this.toggleShop());
    const title = this.add
      .text(BASE_W / 2, 32, "MOON FORGE", {
        color: "#34e5c8",
        fontFamily: "monospace",
        fontSize: "16px",
      })
      .setOrigin(0.5);
    const sub = this.add
      .text(BASE_W / 2, 52, "permanent upgrades — carry into every run", {
        color: "#8b95a1",
        fontFamily: "monospace",
        fontSize: "8px",
      })
      .setOrigin(0.5);
    this.shopShards = this.add
      .text(BASE_W / 2, 68, "", { color: "#ffd15c", fontFamily: "monospace", fontSize: "9px" })
      .setOrigin(0.5);
    panel.add([dim, title, sub, this.shopShards]);
    const top = 98;
    this.shopRows = UPGRADES.map((_, i) => {
      const t = this.add
        .text(BASE_W / 2, top + i * 22, "", {
          color: "#b8c1cc",
          fontFamily: "monospace",
          fontSize: "10px",
        })
        .setOrigin(0.5);
      // Tap a row to select it; tap the selected row to buy (two taps so a
      // stray touch never spends shards). Padding fattens the hit target.
      t.setPadding(30, 5, 30, 5)
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => {
          if (!this.shopOpen) {
            return;
          }
          if (this.shopIndex === i) {
            this.buySelected();
          } else {
            this.shopIndex = i;
            sfx.select();
            this.refreshShop();
          }
        });
      panel.add(t);
      return t;
    });
    // The panel's own hint calls ✕ the way out, so it has to clear the notch
    // and the pause/mute cluster — a landscape phone puts both in this corner.
    const close = this.add
      .text(BASE_W - 18 - ins.right, 16 + ins.top + touchHudBand(this), "✕", {
        color: "#8b95a1",
        fontFamily: "monospace",
        fontSize: "13px",
      })
      .setOrigin(0.5)
      .setPadding(8, 8, 8, 8)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.shopOpen && this.toggleShop());
    panel.add(close);
    // Clears the hub's own tap row, which the panel dims but does not move.
    const hint = this.add
      .text(
        BASE_W / 2,
        BASE_H - 20 - ins.bottom - (this.touch ? 26 : 0),
        this.touch
          ? "tap a row to select — tap again to buy — ✕ closes"
          : "↑ ↓  select      ENTER  buy      M  close",
        {
          color: "#59636f",
          fontFamily: "monospace",
          fontSize: "8px",
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
    if (this.shopOpen) {
      this.refreshShop();
    }
  }

  private shopMove(d: number) {
    this.shopIndex = (this.shopIndex + d + UPGRADES.length) % UPGRADES.length;
    sfx.select();
    this.refreshShop();
  }

  private buySelected() {
    const u = UPGRADES[this.shopIndex];
    if (!u) {
      return;
    }
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

  private buildRoster(rowY: number, n: number) {
    for (const [i, name] of HERO_ORDER.entries()) {
      const x = ((i + 1) / (n + 1)) * BASE_W;
      const spr = this.add
        .sprite(x, rowY, name, firstFrame(this, name))
        .setOrigin(0.5, HERO_ORIGIN_Y)
        .setScale(1.4);
      spr.play(`${name}:idle`);
      const lock = this.add
        .text(x, rowY - 26, "", { color: "#ffd15c", fontFamily: "monospace", fontSize: "8px" })
        .setOrigin(0.5);
      this.sprites.push(spr);
      this.locks.push(lock);
      // Full-column tap target per hero (works for mouse too): tap selects,
      // tapping the already-selected hero descends (SPACE equivalent).
      this.add
        .zone(x, rowY - 25, BASE_W / (n + 1), 110)
        .setInteractive()
        .on("pointerdown", () => {
          if (this.shopOpen) {
            return;
          }
          if (i === this.index) {
            this.confirm();
          } else {
            this.index = i;
            sfx.select();
            this.refresh();
          }
        });
    }
  }

  private bindKeys() {
    const kb = this.input.keyboard;
    if (!kb) {
      return;
    }
    kb.on("keydown-LEFT", () => this.move(-1));
    kb.on("keydown-A", () => this.move(-1));
    kb.on("keydown-RIGHT", () => this.move(1));
    kb.on("keydown-D", () => this.move(1));
    kb.on("keydown-SPACE", () => this.confirm());
    kb.on("keydown-ENTER", () => this.confirm());
    kb.on("keydown-J", () => this.confirm());
    kb.on("keydown-U", () => this.buyUnlock());
    kb.on("keydown-C", () => this.toggleNet("coop"));
    kb.on("keydown-V", () => this.toggleNet("vs"));
    kb.on("keydown-M", () => this.toggleShop());
    kb.on("keydown-ESC", () => this.shopOpen && this.toggleShop());
    kb.on("keydown-UP", () => this.shopOpen && this.shopMove(-1));
    kb.on("keydown-W", () => this.shopOpen && this.shopMove(-1));
    kb.on("keydown-DOWN", () => this.shopOpen && this.shopMove(1));
    kb.on("keydown-S", () => this.shopOpen && this.shopMove(1));
    kb.once("keydown", () => sfx.unlock());
  }

  private refreshShop() {
    this.shopShards.setText(`✦ ${this.meta.shards} shards`);
    for (const [i, u] of UPGRADES.entries()) {
      const lvl = upgradeLevel(this.meta, u.id);
      const pips = "●".repeat(lvl) + "○".repeat(u.max - lvl);
      const maxed = lvl >= u.max;
      const cost = maxed ? "MAX" : `${u.cost(lvl)} ✦`;
      const sel = i === this.shopIndex;
      const afford = !maxed && this.meta.shards >= u.cost(lvl);
      this.shopRows[i]
        ?.setText(`${sel ? "▸ " : "  "}${u.name.padEnd(11)} ${pips}  ${u.desc}   ${cost}`)
        .setColor(shopRowColor(sel, maxed, afford));
    }
  }

  private refreshButtons(unlocked: boolean, goLabel: string) {
    if (this.goBtn) {
      this.goBtn.txt.setText(goLabel).setColor(unlocked ? "#34e5c8" : "#ffd15c");
      this.goBtn.rect.setStrokeStyle(1, unlocked ? 0x34_e5_c8 : 0xff_d1_5c, 0.9);
    }
    if (this.coopBtn) {
      this.coopBtn.rect.setStrokeStyle(1, this.net === "coop" ? 0x34_e5_c8 : 0x59_63_6f, 0.9);
      this.coopBtn.txt.setColor(this.net === "coop" ? "#34e5c8" : "#8b95a1");
    }
    if (this.vsBtn) {
      this.vsBtn.rect.setStrokeStyle(1, this.net === "vs" ? 0xe8_3f_a0 : 0x59_63_6f, 0.9);
      this.vsBtn.txt.setColor(this.net === "vs" ? "#e83fa0" : "#8b95a1");
    }
  }

  private refresh() {
    const name = HERO_ORDER[this.index];
    if (!name) {
      return;
    }
    const def = HEROES[name];
    for (const [i, spr] of this.sprites.entries()) {
      const heroName = HERO_ORDER[i];
      const locked = heroName ? !isUnlocked(this.meta, heroName) : false;
      spr.setScale(i === this.index ? 2 : 1.3);
      spr.setAlpha(heroAlpha(i === this.index, locked));
      spr.setTint(locked ? 0x2a_33_40 : 0xff_ff_ff);
    }
    const sel = this.sprites[this.index];
    if (sel) {
      const hex = `#${def.color.toString(16).padStart(6, "0")}`;
      this.selGlow.setPosition(sel.x, this.rowY + 3).setFillStyle(def.color, 0.22);
      this.selRing.setPosition(sel.x, this.rowY + 3).setStrokeStyle(1.5, def.color, 0.95);
      // keep the bobbing y from its tween
      this.selArrow.setX(sel.x).setColor(hex);
    }
    for (const [i, l] of this.locks.entries()) {
      const hn = HERO_ORDER[i];
      l.setText(hn && !isUnlocked(this.meta, hn) ? `🔒 ${UNLOCK_COST[hn]}` : "");
    }
    this.title.setText(def.title).setColor(`#${def.color.toString(16).padStart(6, "0")}`);
    this.blurb.setText(def.blurb);
    // The run controls render from the manifest as the pause panel's keycap
    // rows (touch vs keys, plus gamepad while a pad is connected — the context
    // watcher re-runs refresh() on connect). Hub verbs below stay hand-written.
    this.renderControls();

    const unlocked = isUnlocked(this.meta, name);
    const cost = UNLOCK_COST[name];
    const goLabel = goLabelFor(this.net, unlocked, cost);
    this.hint.setText(hintFor(this.touch, unlocked, goVerb(this.net), goLabel, cost));
    this.refreshButtons(unlocked, goLabel);
    const bothDo = this.touch ? `tap ${this.net === "vs" ? "DUEL" : "JOIN CO-OP"}` : "press SPACE";
    this.coopText
      .setText(lobbyLine(this.net, this.code, bothDo))
      .setColor(this.net === "vs" ? "#e83fa0" : "#34e5c8");
    this.bank.setText(
      `✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}   ★ ${loadBestScore()}`,
    );
  }

  // The pause panel's control language, mirrored in Phaser: method dividers
  // (grey caption between short bars), gold pixel keycaps (steel-blue border,
  // night fill, bottom bevel), blue-grey actions. Same-action inputs merge
  // within a group ("J / X" attack), the pause panel's voice. Lives in the sky
  // band under CHOOSE YOUR WARRIOR; wrapped rows shrink to fit the band.
  private renderControls(): void {
    const LABELS = {
      camera: "CAMERA",
      controller: "GAMEPAD",
      keys: "KEYBOARD",
      mouse: "MOUSE",
      touch: "TOUCH",
    } satisfies Record<ControlMethod, string>;
    const blocks = controlGroups(CONTROLS, { coarse: this.touch }).map((group) => {
      const byAction = new Map<string, string[]>();
      for (const entry of group.entries) {
        const inputs = byAction.get(entry.action);
        if (inputs) {
          if (!inputs.includes(entry.input)) {
            inputs.push(entry.input);
          }
        } else {
          byAction.set(entry.action, [entry.input]);
        }
      }
      return {
        method: group.method,
        pairs: [...byAction].map(([action, inputs]) => ({ action, keys: inputs.join(" / ") })),
      };
    });
    const sig = JSON.stringify(blocks);
    if (this.controlsBlock && sig === this.controlsSig) {
      return;
    }
    this.controlsSig = sig;
    this.controlsBlock?.destroy();
    const container = this.add.container(0, 0);
    this.controlsBlock = container;
    if (blocks.length === 0) {
      return;
    }

    type Obj = Phaser.GameObjects.Text | Phaser.GameObjects.Rectangle;
    interface Item {
      objs: Obj[];
      width: number;
    }
    const mono = (text: string, color: string, bold = false): Phaser.GameObjects.Text =>
      this.add.text(0, 0, text, {
        color,
        fontFamily: "monospace",
        fontSize: "8px",
        fontStyle: bold ? "bold" : "normal",
      });

    const maxW = BASE_W - 20;
    const gapX = 9;
    const lineH = 15;
    const rows: Item[][] = [];
    let row: Item[] = [];
    let rowW = 0;
    const flushRow = (): void => {
      if (row.length > 0) {
        rows.push(row);
      }
      row = [];
      rowW = 0;
    };
    const addItem = (item: Item): void => {
      const grown = row.length > 0 ? rowW + gapX + item.width : item.width;
      if (row.length > 0 && grown > maxW) {
        flushRow();
      }
      rowW = row.length > 0 ? rowW + gapX + item.width : item.width;
      row.push(item);
    };

    for (const block of blocks) {
      // each method starts its own row
      flushRow();
      const caption = mono(LABELS[block.method], "#59636f").setOrigin(0, 0.5);
      const barL = this.add.rectangle(0, 0, 10, 2, 0x1e_27_33).setOrigin(0, 0.5);
      const barR = this.add
        .rectangle(14 + Math.ceil(caption.width) + 4, 0, 10, 2, 0x1e_27_33)
        .setOrigin(0, 0.5);
      caption.setPosition(14, 0);
      addItem({ objs: [barL, caption, barR], width: 28 + Math.ceil(caption.width) });
      for (const pair of block.pairs) {
        const keyText = mono(pair.keys, "#ffd15c", true).setOrigin(0.5);
        const chipW = Math.ceil(keyText.width) + 8;
        const chip = this.add
          .rectangle(chipW / 2, 0, chipW, 12, 0x14_19_22)
          .setStrokeStyle(2, 0x33_44_5e);
        const bevel = this.add.rectangle(chipW / 2, 4, chipW - 4, 2, 0x0a_0c_11);
        keyText.setPosition(chipW / 2, 0);
        const action = mono(pair.action, "#b8c1cc").setOrigin(0, 0.5);
        action.setPosition(chipW + 4, 0);
        addItem({
          objs: [chip, bevel, keyText, action],
          width: chipW + 4 + Math.ceil(action.width),
        });
      }
    }
    flushRow();

    let y = 0;
    for (const line of rows) {
      const width = line.reduce((sum, item) => sum + item.width, 0) + gapX * (line.length - 1);
      let x = -width / 2;
      for (const item of line) {
        for (const obj of item.objs) {
          obj.setPosition(obj.x + x, obj.y + y);
          container.add(obj);
        }
        x += item.width + gapX;
      }
      y += lineH;
    }

    // Sky band between the subtitle and the warriors' heads: 66..102.
    const totalH = (rows.length - 1) * lineH + 12;
    const scale = Math.min(1, 36 / totalH);
    container.setScale(scale).setPosition(BASE_W / 2, 84 - ((rows.length - 1) * lineH * scale) / 2);
  }

  // Host an online room: mint a code and put it (plus the mode flag) in the URL
  // so it's shareable. Pressing the same key again turns it off; the other key
  // switches modes and keeps the code. (A joiner already arrived with ?party.)
  private toggleNet(mode: "coop" | "vs") {
    if (this.shopOpen) {
      return;
    }
    sfx.select();
    const url = new URL(location.href);
    if (this.net === mode) {
      this.net = "off";
      this.code = "";
      url.searchParams.delete("party");
      url.searchParams.delete("mode");
    } else {
      if (this.net === "off") {
        this.code = randomCode();
      }
      this.net = mode;
      url.searchParams.set("party", this.code);
      if (mode === "vs") {
        url.searchParams.set("mode", "vs");
      } else {
        url.searchParams.delete("mode");
      }
    }
    history.replaceState(null, "", url.toString());
    this.refresh();
  }

  // Start a run — only ever with an already-unlocked hero. A locked hero can't
  // be picked here; it must be deliberately bought first (buyUnlock, the U key),
  // so mashing "go" on the death screen never silently spends your shards.
  private confirm() {
    if (this.shopOpen) {
      return this.buySelected();
    }
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (!isUnlocked(this.meta, hero)) {
      sfx.hurt();
      this.cameras.main.shake(140, 0.006);
      return;
    }
    sfx.door();
    this.registry.set("hero", hero);
    this.registry.set("party", this.net === "off" ? "" : this.code);
    this.registry.set("mode", this.net === "vs" ? "vs" : "");
    notifyGameStarted();
    this.scene.start("game", { hero });
  }

  // Deliberate hub purchase: spend shards to unlock the highlighted hero. Never
  // starts a run — you pick it with a second, explicit "descend" press.
  private buyUnlock() {
    if (this.shopOpen) {
      return;
    }
    const hero = HERO_ORDER[this.index] ?? "axion";
    if (isUnlocked(this.meta, hero)) {
      return;
    }
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
