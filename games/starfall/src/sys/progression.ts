import { sfx } from "../audio/sfx";
import { shipHullPoints } from "../render/vector-shapes";
import type { GameScene } from "../scenes/game-scene";
import {
  COMBO_WINDOW_MS,
  LEECH_FIELD_HEAL,
  LEECH_FIELD_RANGE,
  LEVEL_CAP,
  SHIELD_MAX,
  SHIELD_MOD_SPECS,
  SIPHON_HEAL_ASTEROID,
  SIPHON_HEAL_ENEMY,
  SIPHON_HEAL_PLAYER,
  SIPHON_OVERHEAL_MAX,
  XP_DEATH_MAX_DELEVELS,
  XP_DEATH_PENALTY_FRAC,
  baseRegenMult,
  baseWeaponForLevel,
  comboMult,
  scaleWeaponForLevel,
  xpToNext,
} from "../shared/constants";
import { dist2 } from "./geometry";

type ProgressScene = Pick<
  GameScene,
  | "alive"
  | "fx"
  | "hud"
  | "myTint"
  | "regenMult"
  | "shield"
  | "shipAngle"
  | "shipX"
  | "shipY"
  | "specialBase"
  | "time"
  | "trauma"
  | "weapon"
  | "weaponUntil"
>;

/** SIPHON heal per kill kind. */
export const SIPHON_HEAL = {
  asteroid: SIPHON_HEAL_ASTEROID,
  enemy: SIPHON_HEAL_ENEMY,
  player: SIPHON_HEAL_PLAYER,
  ufo: SIPHON_HEAL_ENEMY,
} as const;

/** Kill credit, combo streak, XP and levelling: the single XP sink, level-up loadout + feedback, and the death tax. */
export class Progression {
  /** Levelling: you level by destroying things; XP is into the current level. */
  level = 1;

  xp = 0;

  /** Monotonic cumulative XP earned this run — feeds diag.score. Unlike
   *  `xp` (into-level progress) it never drops on level-up or death tax. */
  runXp = 0;

  /** dir-006 sector chase: pts this sector. Accrues wherever runXp does
   *  (pre-cap-discard, one sink), owner-resets to 0 at each sector boundary,
   *  and deaths cost exactly 0 — monotonic within a sector. Pure scoreboard. */
  sectorScore = 0;

  // combo (purely local; streak mirrored for nameplates/minimap)
  streak = 0;

  comboExpiresAt = 0;

  comboTier = 1;

  private readonly scene: ProgressScene;

  constructor(scene: ProgressScene) {
    this.scene = scene;
  }

  /** A kill: bump the streak, award table value × multiplier, milestone FX.
   *  SIPHON hooks here, so predicted kills heal — consistent with the
   *  self-award scoring grammar. */
  registerKill(
    base: number,
    now: number,
    kind: "enemy" | "asteroid" | "ufo" | "player",
    x = this.scene.shipX,
    y = this.scene.shipY,
  ): void {
    if (this.scene.shield.shieldMod === "siphon" && this.scene.alive) {
      const heal = SIPHON_HEAL[kind];
      this.scene.shield.shieldHp = Math.min(SIPHON_OVERHEAL_MAX, this.scene.shield.shieldHp + heal);
      this.scene.shield.siphonPulseUntil = now + 250;
      const d = Math.hypot(x - this.scene.shipX, y - this.scene.shipY);
      this.scene.fx.converge(
        this.scene.shipX,
        this.scene.shipY,
        4,
        Math.max(24, Math.min(300, d)),
        250,
        SHIELD_MOD_SPECS.siphon.tint,
      );
    }
    // LEECH FIELD: enemy kills within range heal you (own kills only — simple,
    // no overheal bank, capped at base shield).
    if (
      this.scene.shield.shieldMod === "leech" &&
      this.scene.alive &&
      kind === "enemy" &&
      dist2(x, y, this.scene.shipX, this.scene.shipY) <= LEECH_FIELD_RANGE * LEECH_FIELD_RANGE
    ) {
      this.scene.shield.shieldHp = Math.min(
        SHIELD_MAX,
        this.scene.shield.shieldHp + LEECH_FIELD_HEAL,
      );
      this.scene.fx.sparks(this.scene.shipX, this.scene.shipY, 3, SHIELD_MOD_SPECS.leech.tint, {
        lifeMax: 200,
        lifeMin: 120,
      });
    }
    this.streak += 1;
    this.comboExpiresAt = now + COMBO_WINDOW_MS;
    const mult = comboMult(this.streak);
    this.gainXp(base * mult, now);
    if (mult > this.comboTier && mult >= 2) {
      // Tier-up: the one allowed long effect (§9) + rising sfx + pill pop.
      sfx.play("combo_up", { priority: "local", rate: 2 ** ((2 * (mult - 2)) / 12) });
      this.scene.trauma.add(0.1);
      this.scene.fx.ring(this.scene.shipX, this.scene.shipY, 6, 75, 350, 0xff_ff_ff, 0.8);
      this.scene.fx.converge(this.scene.shipX, this.scene.shipY, 12, 40, 300, 0xff_ff_ff);
      this.scene.time.delayedCall(300, () => {
        if (this.scene.alive) {
          this.scene.fx.sparks(this.scene.shipX, this.scene.shipY, 12, 0xff_ff_ff, {
            lifeMax: 350,
            lifeMin: 200,
            speedMax: 250,
            speedMin: 100,
          });
        }
      });
      if (this.scene.hud.comboEl) {
        this.scene.hud.comboEl.classList.remove("pop");
        // restart the CSS animation
        void this.scene.hud.comboEl.offsetWidth;
        this.scene.hud.comboEl.classList.add("pop");
      }
    }
    this.comboTier = mult;
  }

  /** The single XP sink: add XP, roll up levels, fire the level-up feedback.
   *  Kills route here combo-multiplied (via registerKill); orbs + asteroid
   *  chips call this directly (flat). */
  gainXp(amount: number, now: number): void {
    if (amount <= 0 || !this.scene.alive) {
      return;
    }
    this.runXp += amount;
    // dir-006: sector pts ride the same sink BEFORE the level-cap discard —
    // at cap the XP stream still lands on the sector scoreboard.
    this.sectorScore += amount;
    this.xp += amount;
    let leveled = false;
    while (this.level < LEVEL_CAP && this.xp >= xpToNext(this.level)) {
      this.xp -= xpToNext(this.level);
      this.level += 1;
      leveled = true;
    }
    // at cap the bar empties — no hoard
    if (this.level >= LEVEL_CAP) {
      this.xp = 0;
    }
    if (leveled) {
      this.onLevelUp(now);
    }
  }

  /** Apply the new base loadout + the one allowed long FX (ring + converge +
   *  sparks, reusing the combo-tier vocabulary) + a pitched cue + HUD pop. */
  private onLevelUp(now: number): void {
    this.applyBaseLoadout(now);
    sfx.play("combo_up", { priority: "local", rate: 1.5 });
    this.scene.trauma.add(0.12);
    const tint = this.scene.myTint();
    this.scene.fx.hullUpgrade(
      this.scene.shipX,
      this.scene.shipY,
      shipHullPoints(this.level),
      this.scene.shipAngle,
      this.level,
    );
    this.scene.fx.ring(this.scene.shipX, this.scene.shipY, 8, 110, 450, tint, 0.75, "important");
    this.scene.fx.converge(
      this.scene.shipX,
      this.scene.shipY,
      16,
      60,
      320,
      0xff_ff_ff,
      "important",
    );
    this.scene.fx.sparks(this.scene.shipX, this.scene.shipY, 16, tint, {
      importance: "important",
      lifeMax: 450,
      lifeMin: 250,
      speedMax: 280,
      speedMin: 120,
    });
  }

  /** Apply the level's regen + weapon. A held special is re-scaled for the new
   *  level (from its unscaled base, so it never compounds); otherwise the level
   *  base weapon. Called on level-up, respawn, and special expiry. */
  applyBaseLoadout(now: number): void {
    this.scene.regenMult = baseRegenMult(this.level);
    if (this.scene.weaponUntil > now && this.scene.specialBase) {
      this.scene.weapon = scaleWeaponForLevel(this.scene.specialBase, this.level);
    } else {
      this.scene.specialBase = null;
      this.scene.weapon = baseWeaponForLevel(this.level);
    }
  }

  /** Death tax: lose XP_DEATH_PENALTY_FRAC of progress into the current level;
   *  de-level at most XP_DEATH_MAX_DELEVELS, never below the level floor. The
   *  leader pays the most absolute XP (anti-snowball); a fresh player barely
   *  notices (cheap early levels). */
  applyDeathXpPenalty(): void {
    this.xp -= Math.round(xpToNext(this.level) * XP_DEATH_PENALTY_FRAC);
    let delevels = 0;
    while (this.xp < 0 && this.level > 1 && delevels < XP_DEATH_MAX_DELEVELS) {
      this.level -= 1;
      this.xp += xpToNext(this.level);
      delevels += 1;
    }
    if (this.xp < 0) {
      this.xp = 0;
    }
  }
}
