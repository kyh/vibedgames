import type { GameObjects, Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS } from "../config";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { NetSession } from "../net/session";
import type { NetVersus } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import { duelHits, livePlayers, ownerId, seatPlayer } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { hitSpark, impactRing, popText } from "../sys/fx";
import { VS_HEARTS, VS_WIN_SCORE, vsPhaseFrozen } from "../sys/versus";
import type { VsSide } from "../sys/versus";
import type { BannerHud } from "./banner-hud";
import type { Combat, DuelTarget } from "./combat";
import type { SceneChrome, SceneHooks } from "./scene-hooks";

// setText skips equal strings; setColor always re-rasterises, so guard it.
const paint = (text: GameObjects.Text, value: string, color: string): void => {
  text.setText(value);
  if (text.style.color !== color) {
    text.setColor(color);
  }
};

export interface VersusFlowDeps {
  scene: Scene;
  run: RunState;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  combat: Combat;
  chrome: SceneChrome;
  touch: boolean;
  hooks: SceneHooks;
}

// Online versus (mode "versus"): the host runs the pure match machine
// (sys/versus.ts) and resolves the duel; guests mirror its broadcast into
// `run.matchNet`. Everything here is null/idle in solo and co-op.
export class VersusFlow implements DuelTarget {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly combat: Combat;
  private readonly chrome: SceneChrome;
  private readonly touch: boolean;
  private readonly hooks: SceneHooks;
  // guest: opponent-left banner fired
  opponentGone = false;

  constructor(deps: VersusFlowDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.combat = deps.combat;
    this.chrome = deps.chrome;
    this.touch = deps.touch;
    this.hooks = deps.hooks;
  }

  // Versus: the host walked away — nothing will ever update again; say so.
  noticeOpponentGone(sess: NetSession) {
    if (
      this.seat.mode !== "versus" ||
      this.opponentGone ||
      this.room.guest.snapT <= 0 ||
      sess.otherPlayer()
    ) {
      return;
    }
    this.opponentGone = true;
    this.banners.show(
      this.touch ? "OPPONENT LEFT — EXIT FOR HUB" : "OPPONENT LEFT — ESC FOR HUB",
      60_000,
      "critical",
    );
  }

  // Guest: mirror the versus match state; edge-detect phase changes for the
  // banners + stings (scores/hearts render from the snapshot every frame).
  applyNet(v: NetVersus | null) {
    const prev = this.run.matchNet;
    this.run.matchNet = v;
    if (!v || v.phase === (prev?.phase ?? "")) {
      return;
    }
    if (v.phase === "countdown") {
      this.banners.show(v.round === 1 ? "ROUND 1" : `ROUND ${v.round}`, 1100, "critical");
    } else if (v.phase === "fighting") {
      this.banners.show("FIGHT!", 700, "critical");
      sfx.bossRoar();
    } else if (v.phase === "roundEnd") {
      this.banners.show(`${this.name(v.winner)} TAKES THE ROUND`, 1500, "critical");
      sfx.die();
    } else if (v.phase === "matchEnd") {
      this.banners.show(
        `${this.name(v.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60_000,
        "critical",
      );
    }
  }

  showAdoptedResult(): void {
    const match = this.seat.role === "guest" ? this.run.matchNet : this.run.match?.encode();
    if (match?.phase === "matchEnd") {
      this.banners.show(
        `${this.name(match.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60_000,
        "critical",
      );
    }
  }

  // Host: the duel sim — two players + their projectiles + PvP resolution. No
  // enemies, doors, features, shared hearts, or last stand in this mode.
  simStep(dt: number) {
    const vs = this.run.match;
    if (!vs) {
      return;
    }
    const trans = vs.step(dt);
    if (trans === "fight") {
      this.banners.show("FIGHT!", 700, "critical");
      sfx.bossRoar();
    } else if (trans === "respawn") {
      this.respawn();
      this.banners.show(`ROUND ${vs.round}`, 1100, "critical");
      sfx.door("local");
    } else if (trans === "matchEnd") {
      this.banners.show(
        `${this.name(vs.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60_000,
        "critical",
      );
    }
    for (const pl of livePlayers(this.seat)) {
      pl.step(dt);
    }
    this.combat.stepShots(dt, vs.phase === "fighting" ? this : null);
    if (vs.phase === "fighting" && this.seat.remote) {
      this.offense(this.seat.player, this.seat.remote);
      this.offense(this.seat.remote, this.seat.player);
    }
    this.hooks.updateHud();
  }

  // Reset both duelists onto their mirrored spawn points (round start / lobby).
  respawn() {
    for (const s of this.room.shots) {
      s.spr.destroy();
    }
    this.room.shots = [];
    const pls = [this.seat.player, this.seat.remote];
    for (const pl of pls) {
      if (!pl) {
        continue;
      }
      const s = this.room.vsSpawns[this.side(pl) === "host" ? 0 : 1] ?? this.room.roomSpawn;
      pl.body.dead = false;
      pl.enterRoom(this.room.grid, s.x, s.y);
    }
    this.hooks.updateHud();
  }

  // One duelist's melee / special / stomp / projectile intents against the other.
  private offense(att: Player, vic: Player) {
    const seq = duelHits(this.seat, att);
    const dir = Math.sign(vic.body.x - att.body.x) || att.body.facing;
    const ab = att.body.attackBox();
    // Burn the swing id only when the hit actually LANDS. Marking it on mere
    // overlap spent the swing on a target that was still in hurt i-frames, so
    // when those lapsed a few steps later — while the very same hitbox was
    // still live — the blade passed straight through. A landed hit grants 0.9s
    // of i-frames, far longer than any active window, so this cannot double-hit.
    if (
      ab &&
      att.body.swingId !== seq.swing &&
      !vic.body.dead &&
      rectsOverlap(ab, vic.body.hurtBox()) &&
      this.hurt(vic, ab.dmg, dir)
    ) {
      seq.swing = att.body.swingId;
    }
    const sb = att.body.specialBox();
    if (
      sb &&
      att.body.specialId !== seq.special &&
      !vic.body.dead &&
      rectsOverlap(sb, vic.body.hurtBox()) &&
      this.hurt(vic, sb.dmg, dir)
    ) {
      seq.special = att.body.specialId;
    }
    this.intents(att);
    if (att.body.vy > 20 && !vic.body.dead) {
      this.stomp(att, vic);
    }
  }

  // Launched shots and self-heals fire once, on the frame the body queues them.
  private intents(att: Player) {
    if (att.body.pendingShot) {
      const s = att.body.pendingShot;
      this.combat.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg, att);
      att.body.pendingShot = null;
    }
    if (att.body.pendingHeal > 0) {
      this.run.match?.heal(this.side(att), att.body.pendingHeal);
      popText(this.scene, att.body.x, att.body.y - 26, "+HP", "#34e5c8");
      sfx.heal(att === this.seat.player ? "local" : "routine");
      att.body.pendingHeal = 0;
      this.hooks.updateHud();
    }
  }

  // TowerFall classic: landing on the opponent's head costs them a heart.
  private stomp(att: Player, vic: Player) {
    const { top } = vic.body.hurtBox();
    if (att.body.y <= top + 8 && att.body.y >= top - 12 && Math.abs(att.body.x - vic.body.x) < 12) {
      att.body.bounce();
      sfx.jump();
      this.hurt(vic, 1, Math.sign(att.body.vx) || 1);
    }
  }

  // Versus damage: lands on the victim's OWN hearts (no shared pool, no last
  // stand); dash/hurt i-frames still gate it. A fatal hit ends the round.
  // Returns whether the hit actually connected (see the swing-id guard above).
  hurt(vic: Player, dmg: number, dir: number): boolean {
    const vs = this.run.match;
    if (!vs || vs.phase !== "fighting") {
      return false;
    }
    if (!vic.body.applyHurt(dir)) {
      return false;
    }
    this.run.freeze = Math.max(this.run.freeze, 0.06);
    hitSpark(this.scene, vic.x, vic.y - 11, COLORS.magenta, 8);
    sfx.hit();
    this.hooks.shake(80, 0.005);
    const ended = vs.damage(this.side(vic), dmg);
    this.hooks.updateHud();
    if (ended) {
      this.roundOver(vic);
    }
    return true;
  }

  // The fatal hit: drop the loser where they stand and bank the round.
  private roundOver(loser: Player) {
    const vs = this.run.match;
    if (!vs) {
      return;
    }
    loser.body.dead = true;
    this.run.freeze = Math.max(this.run.freeze, 0.12);
    this.hooks.shake(260, 0.014);
    impactRing(this.scene, loser.x, loser.y - 11, COLORS.magenta, 36);
    sfx.die();
    this.banners.show(`${this.name(vs.winner)} TAKES THE ROUND`, 1500, "critical");
    this.hooks.updateHud();
  }

  // Which wire side a Player object is — only meaningful on the host, where
  // seat.player IS the host duelist.
  private side(pl: Player): VsSide {
    const id = ownerId(this.seat, pl);
    if (id) {
      return id === this.seat.seats.host ? "host" : "guest";
    }
    return pl === this.seat.player ? "host" : "guest";
  }

  // The Player rendering a wire side on THIS client (host: player/remote;
  // guest: remote is the host's puppet).
  private duelist(side: VsSide): Player | undefined {
    if (this.seat.session) {
      const id = this.seat.seats[side];
      return id ? seatPlayer(this.seat, id) : undefined;
    }
    if (this.seat.role === "guest") {
      return side === "guest" ? this.seat.player : this.seat.remote;
    }
    return side === "host" ? this.seat.player : this.seat.remote;
  }

  // Input-aware match-end hint: touch players rematch with ATK / leave via the
  // on-screen EXIT button; keyboard keeps J / ESC.
  private rematchHint(): string {
    return this.touch ? "ATK REMATCH · EXIT HUB" : "J REMATCH · ESC HUB";
  }

  // Banner-friendly duelist name, flagged when it's the local player. The
  // P1/P2 prefix keeps mirror matches unambiguous (both picked the same hero).
  private name(side: VsSide | null): string {
    if (!side) {
      return "";
    }
    const tag = side === "host" ? "P1" : "P2";
    const pl = this.duelist(side);
    if (!pl) {
      return tag;
    }
    return pl === this.seat.player ? `${tag} ${pl.title} (YOU)` : `${tag} ${pl.title}`;
  }

  // Versus HUD, on both clients: host duelist on the left, guest on the right —
  // hero name, this round's hearts, and round-win pips. ▸ marks the local side.
  updateHud() {
    const v = this.seat.role === "guest" ? this.run.matchNet : (this.run.match?.encode() ?? null);
    if (!v) {
      return;
    }
    this.chrome.infoText.setFontSize(12);
    const line = (side: VsSide, hp: number, score: number): string => {
      const pl = this.duelist(side);
      if (!pl) {
        return "AWAITING CHALLENGER…";
      }
      const you = pl === this.seat.player ? "▸" : " ";
      const hearts = "♥".repeat(Math.max(0, hp)) + "♡".repeat(Math.max(0, VS_HEARTS - hp));
      const pips = "●".repeat(score) + "○".repeat(Math.max(0, VS_WIN_SCORE - score));
      return `${you}${pl.title}  ${hearts}  ${pips}`;
    };
    const hex = (side: VsSide): string => {
      const pl = this.duelist(side);
      return pl ? `#${pl.color.toString(16).padStart(6, "0")}` : "#8b95a1";
    };
    paint(this.chrome.heartsText, line("host", v.hostHp, v.hostScore), hex("host"));
    paint(this.chrome.infoText, line("guest", v.guestHp, v.guestScore), hex("guest"));
  }

  frozen(): boolean {
    const phase = this.seat.role === "guest" ? this.run.matchNet?.phase : this.run.match?.phase;
    return phase !== undefined && vsPhaseFrozen(phase);
  }
}
