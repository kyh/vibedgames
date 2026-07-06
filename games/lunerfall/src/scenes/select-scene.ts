import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, HERO_ORIGIN_Y } from "../config";
import { firstFrame } from "../data/animations";
import { HERO_ORDER, HEROES } from "../data/heroes";
import { isUnlocked, loadMeta, type MetaState, UNLOCK_COST, unlockHero } from "../data/meta";

// The hub: pick a warrior, spend shards to unlock the locked ones, then descend.
// Best depth + shard bank persist across runs via localStorage.
export class SelectScene extends Phaser.Scene {
  private index = 0;
  private sprites: Phaser.GameObjects.Sprite[] = [];
  private rings: Phaser.GameObjects.Ellipse[] = [];
  private locks: Phaser.GameObjects.Text[] = [];
  private title!: Phaser.GameObjects.Text;
  private blurb!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private bank!: Phaser.GameObjects.Text;
  private coopText!: Phaser.GameObjects.Text;
  private meta: MetaState = { shards: 0, unlocked: [], bestDepth: 0, runs: 0 };
  private coop = false;
  private code = "";

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
    const n = HERO_ORDER.length;
    HERO_ORDER.forEach((name, i) => {
      const x = ((i + 1) / (n + 1)) * BASE_W;
      const ring = this.add
        .ellipse(x, rowY + 2, 34, 12, HEROES[name].color, 0.18)
        .setVisible(false);
      const spr = this.add
        .sprite(x, rowY, name, firstFrame(this, name))
        .setOrigin(0.5, HERO_ORIGIN_Y)
        .setScale(1.4);
      spr.play(`${name}:idle`);
      const lock = this.add
        .text(x, rowY - 26, "", { fontFamily: "monospace", fontSize: "8px", color: "#ffd15c" })
        .setOrigin(0.5);
      this.rings.push(ring);
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
    kb?.on("keydown-C", () => this.toggleCoop());
    kb?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());

    this.refresh();
  }

  private move(d: number) {
    this.index = (this.index + d + HERO_ORDER.length) % HERO_ORDER.length;
    sfx.select();
    this.refresh();
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
    this.rings.forEach((r, i) => r.setVisible(i === this.index));
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
        ? `← →  choose      SPACE / J  ${go}      C  co-op`
        : `← →  choose      SPACE / J  unlock (${UNLOCK_COST[name]} ✦)`,
    );
    this.coopText.setText(
      this.coop ? `CO-OP ${this.code}  ·  share this page's URL, then both press SPACE` : "",
    );
    this.bank.setText(`✦ ${this.meta.shards}   BEST D${this.meta.bestDepth}`);
  }

  // Host a co-op room: mint a code, put it in the URL so it's shareable, and flip
  // into co-op mode. (A joiner already arrived with ?party set.)
  private toggleCoop() {
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

  private confirm() {
    const hero = HERO_ORDER[this.index] ?? "axion";
    sfx.unlock();
    if (!isUnlocked(this.meta, hero)) {
      if (unlockHero(this.meta, hero)) {
        sfx.pickup();
        this.cameras.main.flash(200, 52, 229, 200);
        this.refresh();
      } else {
        sfx.hurt();
        this.cameras.main.shake(140, 0.006);
      }
      return;
    }
    sfx.door();
    this.registry.set("hero", hero);
    this.registry.set("party", this.coop ? this.code : "");
    this.scene.start("game", { hero });
  }
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(): string {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return c;
}
