import type { GameObjects, Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS } from "../config";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { NetSession } from "../net/session";
import type { NetVersus } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import { duelHits, inputDriven, livePlayers, ownerId, seatPlayer } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { hitSpark, impactRing, popText } from "../sys/fx";
import { VS_HEARTS, VS_WIN_SCORE, vsPhaseFrozen } from "../sys/versus";
import type { VsSide } from "../sys/versus";
import type { BannerHud } from "./banner-hud";
import type { Combat, DuelTarget } from "./combat";
import type { SceneChrome, SceneHooks } from "./scene-hooks";

const paint = (text: GameObjects.Text, value: string, color: string) => {
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

  showAdoptedResult() {
    const match = this.seat.role === "guest" ? this.run.matchNet : this.run.match?.encode();

    if (match?.phase === "matchEnd") {
      this.banners.show(
        `${this.name(match.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60_000,
        "critical",
      );
    }
  }

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
      if (!inputDriven(this.seat, pl)) {
        pl.step(dt);
      }
    }

    this.combat.stepShots(dt, vs.phase === "fighting" ? this : null);

    if (vs.phase === "fighting" && this.seat.remote) {
      this.offense(this.seat.player, this.seat.remote);
      this.offense(this.seat.remote, this.seat.player);
    }

    this.hooks.updateHud();
  }

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
      pl.respawn(this.room.grid, s.x, s.y);
    }

    this.hooks.updateHud();
  }

  private offense(att: Player, vic: Player) {
    const seq = duelHits(this.seat, att);
    const dir = Math.sign(vic.body.x - att.body.x) || att.body.facing;
    const ab = att.body.attackBox();

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

  private stomp(att: Player, vic: Player) {
    const { top } = vic.body.hurtBox();

    if (att.body.y <= top + 8 && att.body.y >= top - 12 && Math.abs(att.body.x - vic.body.x) < 12) {
      att.body.bounce();
      sfx.jump();
      this.hurt(vic, 1, Math.sign(att.body.vx) || 1);
    }
  }

  hurt(vic: Player, dmg: number, dir: number) {
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

  private roundOver(loser: Player) {
    const vs = this.run.match;

    if (!vs) {
      return;
    }

    loser.body.die();
    this.run.freeze = Math.max(this.run.freeze, 0.12);
    this.hooks.shake(260, 0.014);
    impactRing(this.scene, loser.x, loser.y - 11, COLORS.magenta, 36);
    sfx.die();
    this.banners.show(`${this.name(vs.winner)} TAKES THE ROUND`, 1500, "critical");
    this.hooks.updateHud();
  }

  private side(pl: Player) {
    const id = ownerId(this.seat, pl);

    if (id) {
      return id === this.seat.seats.host ? "host" : "guest";
    }

    return pl === this.seat.player ? "host" : "guest";
  }

  private duelist(side: VsSide) {
    if (this.seat.session) {
      const id = this.seat.seats[side];

      return id ? seatPlayer(this.seat, id) : undefined;
    }

    if (this.seat.role === "guest") {
      return side === "guest" ? this.seat.player : this.seat.remote;
    }

    return side === "host" ? this.seat.player : this.seat.remote;
  }

  private rematchHint() {
    return this.touch ? "ATK REMATCH · EXIT HUB" : "J REMATCH · ESC HUB";
  }

  private name(side: VsSide | null) {
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

  updateHud() {
    const v = this.seat.role === "guest" ? this.run.matchNet : (this.run.match?.encode() ?? null);

    if (!v) {
      return;
    }

    this.chrome.infoText.setFontSize(12);

    const line = (side: VsSide, hp: number, score: number) => {
      const pl = this.duelist(side);

      if (!pl) {
        return "AWAITING CHALLENGER…";
      }

      const you = pl === this.seat.player ? "▸" : " ";
      const hearts = "♥".repeat(Math.max(0, hp)) + "♡".repeat(Math.max(0, VS_HEARTS - hp));
      const pips = "●".repeat(score) + "○".repeat(Math.max(0, VS_WIN_SCORE - score));

      return `${you}${pl.title}  ${hearts}  ${pips}`;
    };

    const hex = (side: VsSide) => {
      const pl = this.duelist(side);

      return pl ? `#${pl.color.toString(16).padStart(6, "0")}` : "#8b95a1";
    };

    paint(this.chrome.heartsText, line("host", v.hostHp, v.hostScore), hex("host"));
    paint(this.chrome.infoText, line("guest", v.guestHp, v.guestScore), hex("guest"));
  }

  frozen() {
    const phase = this.seat.role === "guest" ? this.run.matchNet?.phase : this.run.match?.phase;

    return phase !== undefined && vsPhaseFrozen(phase);
  }
}
