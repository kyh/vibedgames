import Phaser from "phaser";

// Character "storybook": pick any hero / creep / neutral and demo its animations,
// its spells (cast at a training dummy, with the real projectiles + fx), and read
// its stats + abilities. Reached via ?viewer. It runs a stripped-down
// sim (one subject + one dummy, no waves/towers/camps) rendered by the real
// WorldView, so everything looks exactly as it does in a match.

import { CREEPS, SIM_DT, enemyOf } from "../data/config";
import type { CreepKind, Team } from "../data/config";
import { DEFAULT_HERO, HERO_BY_ID, HEROES, heroStatAt } from "../data/heroes";
import type { AbilityKey, HeroDef } from "../data/heroes";
import { NEUTRAL_CAMPS } from "../data/map";
import { castAbility } from "../sim/abilities";
import { dealDamage } from "../sim/combat";
import { N_BOSS, N_LARGE, N_SMALL, baseUnit, issueOrder, spawnHero, step } from "../sim/world";
import type { Unit, World } from "../sim/types";
import { nextId } from "../sim/types";
import { FONT } from "../render/font";
import { WorldView } from "../render/view";
import { buildGalleryNav } from "./gallery-nav";

const STAGE = { x: 960, y: 1536 }; // open grass east of the radiant base (walkable)
const DUMMY_DX = 280;
const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

type Entry =
  | { type: "hero"; id: string; label: string }
  | { type: "creep"; ckind: CreepKind; label: string }
  | { type: "neutral"; variant: "skull" | "gnoll" | "minotaur"; label: string };

const ENTRIES: Entry[] = [
  ...HEROES.map((h): Entry => ({ type: "hero", id: h.id, label: h.name })),
  { type: "creep", ckind: "melee", label: "Melee creep" },
  { type: "creep", ckind: "ranged", label: "Ranged creep" },
  { type: "creep", ckind: "siege", label: "Siege creep" },
  { type: "neutral", variant: "skull", label: "Skull (small camp)" },
  { type: "neutral", variant: "gnoll", label: "Gnoll (big camp)" },
  { type: "neutral", variant: "minotaur", label: "Minotaur (Roshan)" },
];

function showcaseWorld(): World {
  return {
    now: 0,
    gameTime: 0,
    phase: "playing",
    winner: null,
    units: new Map(),
    projectiles: new Map(),
    nextWaveAt: Number.POSITIVE_INFINITY, // no creep waves on the stage
    waveCount: 0,
    mines: new Map(),
    groundEffects: [],
    // step()'s tickNeutrals spawns any camp whose respawn time is due; an empty
    // map reads as "due at t=0", so push every camp to never to keep the stage clean.
    campRespawnAt: Object.fromEntries(NEUTRAL_CAMPS.map((c) => [c.id, Number.POSITIVE_INFINITY])),
    fx: [],
    seq: 0,
    rngState: 99,
  };
}

export class ShowcaseScene extends Phaser.Scene {
  private world = showcaseWorld();
  private view!: WorldView;
  private acc = 0;
  private index = 0;
  private faction: Team = "radiant";
  private subject: Unit | null = null;
  private dummy: Unit | null = null;
  private mode: "idle" | "walk" | "attack" = "idle";
  private busyUntil = 0; // while > scene time, skip the idle-pin so a cast's dash can play
  private deathAt = 0; // scene time to rebuild after a death demo (0 = none)
  private listButtons: { idx: number; box: Phaser.GameObjects.Rectangle }[] = [];
  private actionBar: Phaser.GameObjects.GameObject[] = [];
  private info!: Phaser.GameObjects.Text;
  private infoName!: Phaser.GameObjects.Text;
  private factionLabel!: Phaser.GameObjects.Text;

  constructor() {
    super("Showcase");
  }

  create(): void {
    this.world = showcaseWorld();
    this.acc = 0;
    this.mode = "idle";
    this.busyUntil = 0;
    this.deathAt = 0;
    this.listButtons = [];
    this.actionBar = [];

    this.cameras.main.setBackgroundColor("#2c4a2e");
    this.cameras.main.centerOn(STAGE.x + DUMMY_DX / 2, STAGE.y);
    this.cameras.main.setZoom(1);

    this.view = new WorldView(this);
    // a soft grass stage floor; each unit carries its own drop shadow (WorldView),
    // so no extra shadow pads here.
    this.add.ellipse(STAGE.x + DUMMY_DX / 2, STAGE.y + 40, 760, 300, 0x3a5e3c).setDepth(-900);

    this.buildChrome();
    this.buildList();
    this.select(0);

    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 400);
    }
  }

  // ---- world setup ---------------------------------------------------------
  private clearWorld(): void {
    this.world.units.clear();
    this.world.projectiles.clear();
    this.world.groundEffects = [];
    this.world.mines.clear();
    this.world.fx = [];
    // drop the old subject/dummy sprites silently — a swap isn't a death.
    this.view.clearUnitViews();
  }

  /** Spawn a renderable creep/neutral unit (the gallery "units" page only shows
   *  sheets; here they stand on the stage and can attack the dummy). */
  private makeCreep(e: Extract<Entry, { type: "creep" | "neutral" }>, team: Team, x: number): Unit {
    const neutral = e.type === "neutral";
    const ckind: CreepKind = e.type === "creep" ? e.ckind : "melee";
    const boss = neutral && e.variant === "minotaur";
    // neutrals reuse the jungle/Roshan stat blocks so the panel + sprite match a
    // real camp; lane creeps use their CREEPS config.
    const stat = neutral
      ? boss
        ? N_BOSS
        : e.variant === "gnoll"
          ? N_LARGE
          : N_SMALL
      : CREEPS[ckind];
    const u = baseUnit(nextId(this.world, "c"), "creep", team, x, STAGE.y, stat.radius);
    u.maxHp = u.hp = stat.hp;
    u.baseDamage = stat.damage;
    u.armor = stat.armor;
    u.attackRange = stat.attackRange;
    u.attackSpeedBase = stat.attackSpeed;
    u.projectileSpeed = stat.projectileSpeed;
    u.moveSpeedBase = stat.moveSpeed;
    u.neutral = neutral;
    u.creep = { ckind, lane: "top", waypoints: [], wpIdx: 0, spawnWave: 0, boss };
    this.world.units.set(u.id, u);
    return u;
  }

  private select(idx: number): void {
    this.index = ((idx % ENTRIES.length) + ENTRIES.length) % ENTRIES.length;
    this.mode = "idle";
    this.busyUntil = 0;
    this.deathAt = 0;
    this.clearWorld();
    const e = ENTRIES[this.index];
    if (!e) return;

    // training dummy: an enemy that soaks spells/attacks (kept alive in update)
    this.dummy = spawnHero(this.world, "ironvow", enemyOf(this.faction), "dummy", false, 2);
    this.dummy.x = STAGE.x + DUMMY_DX;
    this.dummy.y = STAGE.y;
    this.dummy.order = { type: "hold" };

    if (e.type === "hero") {
      const sub = spawnHero(this.world, e.id, this.faction, "subject", false, 2);
      sub.x = STAGE.x;
      sub.y = STAGE.y;
      sub.facing = 1;
      sub.order = { type: "hold" };
      // max every ability so spells can be demoed immediately
      const sh = sub.hero;
      if (sh) {
        sh.level = 16;
        for (const k of ABILITY_KEYS) sh.abilities[k].rank = k === "R" ? 3 : 4;
      }
      this.subject = sub;
    } else {
      this.subject = this.makeCreep(e, this.faction, STAGE.x);
      this.subject.facing = 1;
      this.subject.order = { type: "hold" };
    }

    this.view.playerHeroId = this.subject.id;
    this.view.playerTeam = this.faction;
    this.refreshInfo();
    this.buildActionBar();
    this.highlightList();
  }

  // ---- demos ---------------------------------------------------------------
  private demoIdle(): void {
    this.mode = "idle";
    this.busyUntil = 0;
    if (this.subject) issueOrder(this.world, this.subject, { type: "hold" });
  }
  private demoWalk(): void {
    this.mode = "walk";
  }
  private demoAttack(): void {
    this.mode = "attack";
    if (this.subject && this.dummy)
      issueOrder(this.world, this.subject, { type: "attackUnit", targetId: this.dummy.id });
  }
  private demoDeath(): void {
    this.mode = "idle";
    if (this.subject) dealDamage(this.world, null, this.subject, 1e9, "pure", {});
    this.deathAt = this.time.now + 2200; // rebuild fresh after the collapse plays
  }
  private demoCast(key: AbilityKey): void {
    const sub = this.subject;
    if (!sub?.hero || !this.dummy) return;
    const def = HERO_BY_ID[sub.hero.defId]?.abilities[key];
    if (!def || def.targeting === "passive") return;
    this.mode = "idle";
    this.busyUntil = this.time.now + 1500; // let a dash/blink in the cast play before re-pinning
    // let it always fire on the stage: top mana + clear cooldown first
    sub.mp = sub.maxMp;
    sub.hero.abilities[key].readyAt = 0;
    if (def.targeting === "unit") {
      const ally = def.effect === "brewkeeper:Q";
      castAbility(this.world, sub, { key, targetId: ally ? sub.id : this.dummy.id });
    } else if (def.targeting === "point") {
      castAbility(this.world, sub, { key, point: { x: this.dummy.x, y: this.dummy.y } });
    } else {
      castAbility(this.world, sub, { key });
    }
  }

  // ---- loop ----------------------------------------------------------------
  override update(_t: number, deltaMs: number): void {
    const dt = Math.min(0.05, deltaMs / 1000);

    // rebuild after a death demo
    if (this.deathAt && this.time.now >= this.deathAt) {
      this.deathAt = 0;
      this.select(this.index);
      return;
    }

    // keep the dummy standing + full so repeated spells always have a target
    const dummy = this.dummy;
    if (dummy) {
      if (!dummy.alive) {
        dummy.alive = true;
        dummy.statuses = [];
        dummy.x = STAGE.x + DUMMY_DX;
        dummy.y = STAGE.y;
      }
      dummy.hp = dummy.maxHp;
      dummy.mp = dummy.maxMp;
      dummy.order = { type: "hold" };
    }

    // walk demo: pace the subject back and forth across the stage
    const sub = this.subject;
    if (this.mode === "walk" && sub && sub.alive) {
      const dir = sub.x > STAGE.x + 110 ? -1 : sub.x < STAGE.x - 110 ? 1 : sub.facing;
      issueOrder(this.world, sub, { type: "moveDir", dx: dir, dy: 0 });
    }
    // keep a hero's mana topped so spells never gate during a demo
    if (sub?.hero && sub.alive && !this.deathAt) sub.mp = sub.maxMp;

    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < 5) {
      step(this.world, SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }

    // Hold each combatant on its mark before sync. Creeps/neutrals auto-acquire the
    // dummy and drift toward it (kicking up running dust); zeroing velocity here also
    // keeps the idle pose. The cast grace window lets a dash/blink travel first.
    if (sub?.alive && this.mode === "idle" && this.time.now >= this.busyUntil) {
      if (sub.order.type !== "hold") sub.order = { type: "hold" };
      sub.x = STAGE.x;
      sub.y = STAGE.y;
      sub.vx = 0;
      sub.vy = 0;
    }
    if (dummy?.alive) {
      dummy.x = STAGE.x + DUMMY_DX;
      dummy.y = STAGE.y;
      dummy.vx = 0;
      dummy.vy = 0;
    }

    this.view.sync(this.world, dt);
  }

  // ---- UI ------------------------------------------------------------------
  private buildChrome(): void {
    const W = this.scale.width;
    buildGalleryNav(this, "viewer");
    this.add
      .text(W / 2, 64, "ELDERMOOR — UI", {
        fontFamily: FONT,
        fontSize: "20px",
        color: "#f4eee0",
        stroke: "#1e2a3a",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000);

    // faction toggle (flips creep/hero sprite faction)
    this.factionLabel = this.add
      .text(W - 16, 20, "", { fontFamily: FONT, fontSize: "15px", color: "#cfe8ff" })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000)
      .setInteractive({ useHandCursor: true });
    this.factionLabel.on("pointerdown", () => {
      this.faction = this.faction === "radiant" ? "dire" : "radiant";
      this.select(this.index);
    });

    // info panel (right)
    this.infoName = this.add
      .text(W - 16, 58, "", {
        fontFamily: FONT,
        fontSize: "20px",
        color: "#fff3c4",
        stroke: "#27343c",
        strokeThickness: 4,
        align: "right",
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);
    this.info = this.add
      .text(W - 16, 92, "", {
        fontFamily: FONT,
        fontSize: "13px",
        color: "#e8eef2",
        align: "right",
        lineSpacing: 4,
        stroke: "#1a242c",
        strokeThickness: 2,
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.input.keyboard?.on("keydown-ESC", () => this.scene.start("Menu"));
    this.add
      .text(16, this.scale.height - 22, "Esc → menu", {
        fontFamily: FONT,
        fontSize: "12px",
        color: "#9fb0bd",
      })
      .setScrollFactor(0)
      .setDepth(1000);
  }

  private buildList(): void {
    let y = 56;
    let group = "";
    for (let i = 0; i < ENTRIES.length; i++) {
      const e = ENTRIES[i];
      if (!e) continue;
      const g = e.type === "hero" ? "HEROES" : e.type === "creep" ? "CREEPS" : "NEUTRALS";
      if (g !== group) {
        group = g;
        this.add
          .text(16, y, g, { fontFamily: FONT, fontSize: "12px", color: "#8fa6b4" })
          .setScrollFactor(0)
          .setDepth(1000);
        y += 20;
      }
      const box = this.add
        .rectangle(16, y, 196, 24, 0x12202a, 0.85)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x33505f)
        .setScrollFactor(0)
        .setDepth(1000)
        .setInteractive({ useHandCursor: true });
      this.add
        .text(26, y + 5, e.label, { fontFamily: FONT, fontSize: "13px", color: "#dbe7ee" })
        .setScrollFactor(0)
        .setDepth(1001);
      const idx = i;
      box.on("pointerdown", () => this.select(idx));
      this.listButtons.push({ idx, box });
      y += 28;
    }
  }

  private highlightList(): void {
    for (const b of this.listButtons)
      b.box.setStrokeStyle(
        b.idx === this.index ? 3 : 1,
        b.idx === this.index ? 0xffe14a : 0x33505f,
      );
  }

  private buildActionBar(): void {
    for (const o of this.actionBar) o.destroy();
    this.actionBar = [];
    const e = ENTRIES[this.index];
    if (!e) return;
    const labels: Array<{ t: string; fn: () => void; hot?: boolean }> = [
      { t: "Idle", fn: () => this.demoIdle() },
      { t: "Walk", fn: () => this.demoWalk() },
      { t: "Attack", fn: () => this.demoAttack() },
    ];
    if (e.type === "hero") {
      const def = HERO_BY_ID[e.id] ?? DEFAULT_HERO;
      for (const k of ABILITY_KEYS) {
        const ab = def.abilities[k];
        if (ab.targeting === "passive") continue;
        labels.push({ t: `${k} · ${ab.name}`, fn: () => this.demoCast(k), hot: true });
      }
    }
    labels.push({ t: "Death", fn: () => this.demoDeath() });

    const W = this.scale.width;
    const barY = this.scale.height - 54;
    let x = Math.max(220, (W - labels.length * 132) / 2);
    for (const l of labels) {
      const w = l.t.length > 10 ? 150 : 96;
      const box = this.add
        .rectangle(x, barY, w, 36, l.hot ? 0x3a2a14 : 0x142028, 0.92)
        .setOrigin(0, 0.5)
        .setStrokeStyle(2, l.hot ? 0xc9941e : 0x3f6475)
        .setScrollFactor(0)
        .setDepth(1000)
        .setInteractive({ useHandCursor: true });
      const txt = this.add
        .text(x + w / 2, barY, l.t, {
          fontFamily: FONT,
          fontSize: "13px",
          color: l.hot ? "#ffe6a3" : "#dbe7ee",
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(1001);
      box.on("pointerover", () => box.setFillStyle(l.hot ? 0x5a3f1e : 0x1d2f3a, 1));
      box.on("pointerout", () => box.setFillStyle(l.hot ? 0x3a2a14 : 0x142028, 0.92));
      box.on("pointerdown", l.fn);
      this.actionBar.push(box, txt);
      x += w + 10;
    }
  }

  private refreshInfo(): void {
    const e = ENTRIES[this.index];
    if (!e) return;
    this.factionLabel.setText(
      `Faction: ${this.faction === "radiant" ? "Radiant ☀" : "Dire 🌙"}  (click)`,
    );
    if (e.type === "hero") {
      const def = HERO_BY_ID[e.id] ?? DEFAULT_HERO;
      this.infoName.setText(`${def.name} — ${def.title}`);
      this.info.setText(this.heroInfo(def));
    } else {
      const u = this.subject;
      this.infoName.setText(e.label);
      this.info.setText(
        u
          ? [
              e.type === "neutral" ? "Neutral monster" : "Lane creep",
              `HP ${Math.round(u.maxHp)}   DMG ${Math.round(u.baseDamage)}   ARMOR ${u.armor}`,
              `range ${u.attackRange}   move ${Math.round(u.moveSpeedBase)}`,
            ].join("\n")
          : "",
      );
    }
  }

  private heroInfo(def: HeroDef): string {
    const s = (k: Parameters<typeof heroStatAt>[1]) => Math.round(heroStatAt(def, k, 1));
    const lines = [
      `${def.role}`,
      `HP ${s("hp")}   MP ${s("mp")}   DMG ${s("damage")}`,
      `armor ${s("armor")}   range ${def.base.attackRange}   move ${s("moveSpeed")}`,
      "",
    ];
    for (const k of ABILITY_KEYS) {
      const a = def.abilities[k];
      lines.push(`[${k}] ${a.name}`);
      lines.push(a.desc);
    }
    return lines.join("\n");
  }
}
