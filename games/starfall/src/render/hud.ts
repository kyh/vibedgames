import { Math as PhaserMath } from "phaser";
import { sfx } from "../audio/sfx";
import type { GameScene } from "../scenes/game-scene";
import { now as simNow } from "../shared/clock";
import {
  BEACON_TINT,
  BOOSTER_SPECS,
  COMBO_WINDOW_MS,
  MINIMAP_H,
  MINIMAP_PAD,
  MINIMAP_W,
  OVERSHIELD_BONUS,
  RESPAWN_DELAY_MS,
  SECTOR_LENGTH_S,
  SECTOR_PULSE_AT_S,
  SECTOR_PULSE_S,
  SECTOR_RECAP_SHOW_S,
  SHIELD_LOW_FRACTION,
  SHIELD_MAX,
  SHIELD_MOD_DURATION_MS,
  SHIELD_MOD_SPECS,
  SIPHON_OVERHEAL_MAX,
  SPECIAL_WEAPON_DURATION_MS,
  baseWeaponForLevel,
  bossPhase,
  callsign,
  comboMult,
  sectorIdx,
  sectorRelT,
} from "../shared/constants";
import type { EnemyState, SharedState } from "../shared/constants";
import { inWorld } from "../sys/geometry";
import { BattleBeatDirector } from "./battle-beat";
import { BossEncounters } from "./boss-encounters";
import { FlightHud } from "./flight-hud";
import { fmtPts, ordinal, setAttribute, setText } from "./hud-dom";
import { drawMinimapItem, drawMinimapWorld } from "./minimap";
import type { MinimapFrame } from "./minimap";
import { hexCss } from "./tint";

type HudScene = Pick<
  GameScene,
  | "alive"
  | "battleBackdrop"
  | "boosts"
  | "connected"
  | "frozen"
  | "live"
  | "mastery"
  | "minimapGfx"
  | "myId"
  | "offline"
  | "paused"
  | "peerStates"
  | "peers"
  | "progress"
  | "respawnAt"
  | "safeInset"
  | "scale"
  | "shield"
  | "shipView"
  | "shipX"
  | "shipY"
  | "spawned"
  | "started"
  | "trailer"
  | "weapon"
  | "weaponUntil"
  | "world"
>;

/** The DOM HUD and minimap: boss bar, weapon/shield/mod/boost/combo readouts, player count, the death overlay with recovery card, sector standings/recap, and the battle presentation directors. */
export class Hud {
  private readonly flightHud = new FlightHud();

  /** Session-local best completed-sector score (solo recap/pulse comparison;
   *  no persistence this cycle). */
  sectorBest = 0;

  /** Last sectorIdx observed; -1 until the first live tick so a mid-sector
   *  joiner adopts the current sector without firing a recap. */
  private lastSectorIdx = -1;

  /** Recap banner hide deadline (sim-clock ms; 0 = hidden). */
  recapUntil = 0;

  // HUD (DOM, owned by index.html)
  bossBarEl: HTMLElement | null = null;

  bossHpEl: HTMLElement | null = null;

  bossLabelEl: HTMLElement | null = null;

  readonly bossEncounters = new BossEncounters();

  readonly battleBeat = new BattleBeatDirector();

  weaponEl: HTMLElement | null = null;

  weaponBarEl: HTMLElement | null = null;

  shieldEl: HTMLElement | null = null;

  shieldFillEl: HTMLElement | null = null;

  shieldOsEl: HTMLElement | null = null;

  shieldModEl: HTMLElement | null = null;

  shieldModBarEl: HTMLElement | null = null;

  boostsEl: HTMLElement | null = null;

  private lastBoostsHtml = "";

  comboEl: HTMLElement | null = null;

  comboValEl: HTMLElement | null = null;

  comboBarEl: HTMLElement | null = null;

  playersEl: HTMLElement | null = null;

  overlayEl: HTMLElement | null = null;

  causeEl: HTMLElement | null = null;

  hintEl: HTMLElement | null = null;

  countdownEl: HTMLElement | null = null;

  recoveryProgressEl: HTMLElement | null = null;

  recoveryFillEl: HTMLElement | null = null;

  recoveryLoadoutEl: HTMLElement | null = null;

  // dir-006 sector surfaces (DOM like the bossbar; zero input capture)
  sectorEl: HTMLElement | null = null;

  recapEl: HTMLElement | null = null;

  pulseEl: HTMLElement | null = null;

  private lastSectorLine = "";

  private lastPulseText = "";

  private readonly scene: HudScene;

  constructor(scene: HudScene) {
    this.scene = scene;
  }

  /** Resolve the HUD's DOM (owned by index.html) once, at scene create. */
  bind(): void {
    this.bossBarEl = document.querySelector("#bossbar");
    this.bossHpEl = document.querySelector("#bosshp");
    this.bossLabelEl = document.querySelector("#bosslabel");
    this.weaponEl = document.querySelector("#weapon");
    this.weaponBarEl = document.querySelector("#weaponbar");
    this.shieldEl = document.querySelector("#shield");
    this.shieldFillEl = document.querySelector("#shieldfill");
    this.shieldOsEl = document.querySelector("#shieldos");
    this.shieldModEl = document.querySelector("#shieldmod");
    this.shieldModBarEl = document.querySelector("#shieldmodbar");
    this.boostsEl = document.querySelector("#boosts");
    this.comboEl = document.querySelector("#combo");
    this.comboValEl = document.querySelector("#comboval");
    this.comboBarEl = document.querySelector("#combobar");
    this.playersEl = document.querySelector("#players");
    this.overlayEl = document.querySelector("#overlay");
    this.causeEl = document.querySelector("#cause");
    this.hintEl = document.querySelector("#hint");
    this.countdownEl = document.querySelector("#countdown");
    this.recoveryProgressEl = document.querySelector("#recovery-progress");
    this.recoveryFillEl = document.querySelector("#recovery-fill");
    this.recoveryLoadoutEl = document.querySelector("#recovery-loadout");
    this.sectorEl = document.querySelector("#sector");
    this.recapEl = document.querySelector("#recap");
    this.pulseEl = document.querySelector("#pulse");
  }

  drawMinimap(now: number): void {
    const g = this.scene.minimapGfx;
    g.clear();
    // trailer HUD policy: no minimap
    if (this.scene.trailer) {
      return;
    }
    // Safe-area insets keep the corner box off the home indicator/notch.
    const x0 = this.scene.scale.width - MINIMAP_W - MINIMAP_PAD - this.scene.safeInset.right;
    const y0 = this.scene.scale.height - MINIMAP_H - MINIMAP_PAD - this.scene.safeInset.bottom;
    g.fillStyle(0x00_00_00, 0.6).fillRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    g.lineStyle(1, 0xff_ff_ff, 0.15).strokeRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    // Map the live PLAY area (not the fixed max) onto the minimap box.
    const map: MinimapFrame = {
      ph: this.scene.world.playH,
      pw: this.scene.world.playW,
      sx: MINIMAP_W / this.scene.world.playW,
      sy: MINIMAP_H / this.scene.world.playH,
      x0,
      y0,
    };
    drawMinimapWorld(g, this.scene.world, map, now);
    for (const it of this.scene.world.items) {
      if (inWorld(it.x, it.y, 0, map.pw, map.ph)) {
        drawMinimapItem(g, it, map);
      }
    }
    const { myId } = this.scene;
    for (const [id, st] of this.scene.peerStates) {
      const isMe = id === myId;
      const tint = this.scene.shipView.ships.get(id)?.tint ?? 0xff_ff_ff;
      let px: number;
      let py: number;
      if (isMe) {
        if (!this.scene.spawned || !this.scene.alive) {
          continue;
        }
        px = this.scene.shipX;
        py = this.scene.shipY;
      } else {
        // each dot filtered by ITS player's alive state
        if (!st || !st.alive) {
          continue;
        }
        px = st.x;
        py = st.y;
      }
      g.fillStyle(tint, 1).fillCircle(map.x0 + px * map.sx, map.y0 + py * map.sy, isMe ? 3 : 2);
    }
  }

  /** Sector standings this instant: self live-local, every present remote from
   *  its last wire value. Best-first; id tiebreak so the order converges
   *  identically on every client. */
  private sectorStandings(): { id: string; pts: number }[] {
    const me = this.scene.myId;
    const rows: { id: string; pts: number }[] = [];
    if (me !== null) {
      rows.push({ id: me, pts: Math.round(this.scene.progress.sectorScore) });
    }
    for (const [id, ns] of this.scene.peerStates) {
      if (id === me || !ns || !ns.present) {
        continue;
      }
      rows.push({ id, pts: Math.round(ns.sectorScore) });
    }
    rows.sort((a, b) => b.pts - a.pts || (a.id < b.id ? -1 : 1));
    return rows;
  }

  /** Per-frame sector clock: boundary detection (recap + owner score reset),
   *  the persistent HUD line, the rel-180/360 standings pulses, and recap
   *  expiry. Every write is DOM — the sim is untouched except the owner-side
   *  reset, so the room never stops for any of it. */
  tickSector(now: number): void {
    const tSec = Math.max(0, (now - this.scene.world.arenaEpoch) / 1000);
    const idx = sectorIdx(tSec);
    const rel = sectorRelT(tSec);
    // First live tick (or a mid-sector joiner): adopt the room's sector
    // silently — no recap for sectors we weren't part of.
    if (this.lastSectorIdx === -1) {
      this.lastSectorIdx = idx;
    }
    if (idx !== this.lastSectorIdx) {
      // Snapshot standings BEFORE the reset — the recap wants final scores.
      // A backwards jump (dev epoch rewind) resyncs without a recap.
      if (idx > this.lastSectorIdx) {
        const rows = this.sectorStandings();
        this.sectorBest = Math.max(this.sectorBest, Math.round(this.scene.progress.sectorScore));
        this.showRecap(this.lastSectorIdx + 1, rows, now);
      }
      // Owner-reset: the boundary is the ONLY thing that zeroes sector pts
      // (deaths cost 0 by construction — nothing else writes this field).
      this.scene.progress.sectorScore = 0;
      this.lastSectorIdx = idx;
    }
    if (this.recapEl) {
      this.recapEl.style.opacity = now < this.recapUntil ? "1" : "0";
    }

    // Persistent line: SECTOR 3 · 4:12 · 1,240 PTS · 2ND (solo: rank omitted).
    const rows = this.sectorStandings();
    const myRank = rows.findIndex((r) => r.id === this.scene.myId) + 1;
    const remS = Math.max(0, Math.ceil(SECTOR_LENGTH_S - rel));
    let line =
      `SECTOR ${idx + 1} · ${Math.floor(remS / 60)}:${String(remS % 60).padStart(2, "0")}` +
      ` · ${fmtPts(Math.round(this.scene.progress.sectorScore))} PTS`;
    if (rows.length > 1 && myRank > 0) {
      line += ` · ${ordinal(myRank)}`;
    }
    if (line !== this.lastSectorLine) {
      this.lastSectorLine = line;
      setText(this.sectorEl, line);
    }

    // Standings pulse fills the two beacon-free troughs; never stacked on top
    // of a boss fight or the recap (they own the player's attention).
    const bossLive = this.scene.world.enemies.some((e) => e.kind === "dreadnought");
    const inPulse = SECTOR_PULSE_AT_S.some((at) => rel >= at && rel < at + SECTOR_PULSE_S);
    const showPulse = inPulse && !bossLive && now >= this.recapUntil;
    if (this.pulseEl) {
      this.pulseEl.style.opacity = showPulse ? "1" : "0";
    }
    if (showPulse) {
      const text = this.pulseText(rows, myRank);
      if (text !== this.lastPulseText) {
        this.lastPulseText = text;
        setText(this.pulseEl, text);
      }
    }
  }

  /** Standings pulse copy: my gap to the leader in a room, else my points
   *  (+ session best) solo. */
  private pulseText(rows: { id: string; pts: number }[], myRank: number): string {
    const [leader] = rows;
    if (rows.length > 1 && myRank > 0 && leader) {
      if (myRank === 1) {
        return `1ST · ${fmtPts(leader.pts - (rows[1]?.pts ?? 0))} AHEAD`;
      }
      const gap = leader.pts - Math.round(this.scene.progress.sectorScore);
      return `${ordinal(myRank)} · ${fmtPts(gap)} BEHIND ${callsign(leader.id)}`;
    }
    const best = this.sectorBest > 0 ? ` · SESSION BEST ${fmtPts(this.sectorBest)}` : "";
    return `${fmtPts(Math.round(this.scene.progress.sectorScore))} PTS${best}`;
  }

  /** Boundary recap: standings snapshot into #recap for SECTOR_RECAP_SHOW_S.
   *  Non-blocking DOM (pointer-events: none) — sim, input and firing continue
   *  behind it; tickSector fades it out on schedule. */
  private showRecap(completedNum: number, rows: { id: string; pts: number }[], now: number): void {
    this.recapUntil = now + SECTOR_RECAP_SHOW_S * 1000;
    // One chime from the gold shared-event family (beacon vocabulary, no new synth).
    sfx.play("beacon_active", { gain: 0.6, rate: 1.3 });
    const el = this.recapEl;
    if (!el) {
      return;
    }
    let html = `<h2>SECTOR ${completedNum} COMPLETE</h2>`;
    if (rows.length <= 1) {
      html += `<div class="row">${fmtPts(rows[0]?.pts ?? 0)} PTS</div>`;
      html += `<div class="recap-best">SESSION BEST ${fmtPts(this.sectorBest)}</div>`;
    } else {
      const entries = rows.map((r, i) => ({
        name: r.id === this.scene.myId ? "YOU" : callsign(r.id),
        pts: r.pts,
        rank: i + 1,
      }));
      const shown = entries.slice(0, 3);
      const mine = entries.find((e) => e.name === "YOU");
      if (mine && mine.rank > 3) {
        shown.push(mine);
      }
      html += shown
        .map((e) => {
          const gold = e.rank === 1 ? ` style="color:${hexCss(BEACON_TINT)}"` : "";
          return `<div class="row"${gold}>${ordinal(e.rank)} · ${e.name} · ${fmtPts(e.pts)}</div>`;
        })
        .join("");
    }
    const currentSector = sectorIdx(Math.max(0, (now - this.scene.world.arenaEpoch) / 1000)) + 1;
    html += `<div class="recap-handoff">SECTOR ${currentSector} · FLIGHT CONTINUES</div>`;
    el.innerHTML = html;
    // dir-009 presence pass: restart the 300ms scale-in alongside the fade,
    // then one winner-row pop ~150ms after the banner lands. DOM-only — the
    // banner stays non-blocking (pointer-events: none, no shake, no input).
    el.classList.remove("in");
    // reflow so back-to-back recaps re-run the animation
    void el.offsetWidth;
    el.classList.add("in");
    // The row accent is CSS-owned; replacing the recap cannot leave a stale timer.
  }

  updateHud(now: number): void {
    const presentation = this.scene.started && !this.scene.trailer;
    this.flightHud.update({
      active:
        presentation &&
        this.scene.spawned &&
        this.scene.alive &&
        !this.scene.paused &&
        !this.scene.frozen,
      level: this.scene.progress.level,
      mastery: this.scene.mastery.state,
      now,
      weaponUntil: this.scene.weaponUntil,
      xp: this.scene.progress.xp,
    });
    const boss = this.scene.world.enemies.find(
      (e) => e.kind === "dreadnought" && e.hp > 0 && e.maxHp > 0,
    );
    this.updateBossBar(boss ?? null, presentation);
    const inFlight = presentation && this.scene.spawned && this.scene.alive && !this.scene.paused;
    if (inFlight) {
      sfx.setMusicMode(boss ? "boss" : "flight");
    } else {
      sfx.setMusicMode("silent");
    }
    this.updateWeaponHud(now);
    this.updateShieldHud(now);
    this.updateBoostsHud(now);
    this.updateComboHud(now);
    const n = Object.keys(this.scene.peers).length;
    setText(this.playersEl, this.playersLabel(n));
    this.updateRecovery(now, presentation);
  }

  private updateBossBar(boss: EnemyState | null, presentation: boolean): void {
    if (!this.bossBarEl || !this.bossHpEl) {
      return;
    }
    this.bossBarEl.hidden = !presentation || !boss;
    this.bossBarEl.style.opacity = boss ? "1" : "0";
    if (boss) {
      const percent = PhaserMath.Clamp((boss.hp / boss.maxHp) * 100, 0, 100);
      this.bossHpEl.style.width = `${percent.toFixed(1)}%`;
      setText(this.bossLabelEl, `DREADNOUGHT · PHASE ${bossPhase(boss.hp, boss.maxHp)}`);
      setAttribute(this.bossBarEl, "aria-valuenow", String(Math.round(percent)));
    }
  }

  private updateWeaponHud(now: number): void {
    setText(this.weaponEl, this.scene.weapon.name);
    if (!this.weaponBarEl) {
      return;
    }
    // A special is active iff weaponUntil is in the future; base weapons show
    // no bar. Stacked pickups can push the timer past one base duration: clamp
    // the bar full; the adjacent seconds retain the complete accepted time.
    const frac =
      this.scene.weaponUntil <= now
        ? 0
        : Math.min(1, Math.max(0, (this.scene.weaponUntil - now) / SPECIAL_WEAPON_DURATION_MS));
    this.weaponBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
    this.weaponBarEl.style.background = hexCss(this.scene.weapon.tint);
  }

  private updateShieldHud(now: number): void {
    if (!this.shieldEl) {
      return;
    }
    if (!this.scene.alive || !this.scene.spawned) {
      this.shieldEl.style.display = "none";
      return;
    }
    this.shieldEl.style.display = "block";
    // SIPHON overheal: the fill runs past the base 40px track (≤1.3×,
    // SIPHON_OVERHEAL_MAX) and tints green while banked above 100.
    const overhealCap = SIPHON_OVERHEAL_MAX / SHIELD_MAX;
    const frac = Math.max(0, Math.min(overhealCap, this.scene.shield.shieldHp / SHIELD_MAX));
    if (this.shieldFillEl) {
      this.shieldFillEl.style.width = `${(frac * 40).toFixed(1)}px`;
      this.shieldFillEl.style.background =
        this.scene.shield.shieldHp > SHIELD_MAX ? hexCss(SHIELD_MOD_SPECS.siphon.tint) : "";
    }
    if (this.shieldOsEl) {
      this.shieldOsEl.style.width = `${((Math.max(0, this.scene.shield.overHp) / OVERSHIELD_BONUS) * 30).toFixed(1)}px`;
    }
    this.shieldEl.classList.toggle(
      "low",
      this.scene.shield.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION,
    );
    this.updateShieldModHud(now);
  }

  private updateShieldModHud(now: number): void {
    const mod = this.scene.shield.shieldMod;
    if (this.shieldModEl) {
      this.shieldModEl.style.display = mod ? "block" : "none";
      if (mod) {
        this.shieldModEl.style.color = hexCss(SHIELD_MOD_SPECS[mod].tint);
        setText(this.shieldModEl, SHIELD_MOD_SPECS[mod].name);
      }
    }
    if (this.shieldModBarEl) {
      const mfrac = mod
        ? Math.min(
            1,
            Math.max(0, (this.scene.shield.shieldModUntil - now) / SHIELD_MOD_DURATION_MS),
          )
        : 0;
      this.shieldModBarEl.style.width = `${(mfrac * 100).toFixed(1)}%`;
      if (mod) {
        this.shieldModBarEl.style.background = hexCss(SHIELD_MOD_SPECS[mod].tint);
      }
    }
  }

  private updateBoostsHud(now: number): void {
    if (!this.boostsEl) {
      return;
    }
    const parts: string[] = [];
    if (this.scene.alive) {
      for (const [kind, until] of this.scene.boosts) {
        const secs = Math.max(0, Math.ceil((until - now) / 1000));
        const spec = BOOSTER_SPECS[kind];
        parts.push(`<span style="color:${hexCss(spec.tint)}">${spec.name} ${secs}</span>`);
      }
    }
    const html = parts.join(" &middot; ");
    if (html !== this.lastBoostsHtml) {
      this.lastBoostsHtml = html;
      this.boostsEl.innerHTML = html;
    }
  }

  private updateComboHud(now: number): void {
    if (!this.comboEl) {
      return;
    }
    const mult = comboMult(this.scene.progress.streak);
    const show = mult >= 2 && this.scene.alive;
    this.comboEl.style.opacity = show ? "1" : "0";
    if (show) {
      setText(this.comboValEl, `×${mult} · ${this.scene.progress.streak}`);
      if (this.comboBarEl) {
        const frac = Math.max(0, (this.scene.progress.comboExpiresAt - now) / COMBO_WINDOW_MS);
        this.comboBarEl.style.width = `${(frac * 100).toFixed(1)}%`;
      }
    }
  }

  private playersLabel(n: number): string {
    if (this.scene.offline) {
      return "solo · offline";
    }
    if (this.scene.connected) {
      return `${n} player${n === 1 ? "" : "s"}`;
    }
    return "reconnecting…";
  }

  /** Encounter edges are tracked even while the cues are silent (start screen,
   * trailer), so starting never replays history. */
  observeBossEncounters(world: SharedState): void {
    const cues = this.bossEncounters.observe(world.arenaEpoch, world.enemies);
    if (!this.scene.started || this.scene.trailer) {
      return;
    }
    for (const cue of cues) {
      if (cue.kind === "arrival") {
        sfx.play("boss_arrival");
      } else if (cue.kind === "phase") {
        sfx.play("boss_phase");
      } else {
        sfx.play("boss_defeat");
        this.battleBeat.bossDefeated(simNow(), world.arenaEpoch);
      }
    }
  }

  updateBattlePresentation(now: number): void {
    const beat = this.battleBeat.update({
      bossAlive: this.scene.world.enemies.some(
        (enemy) => enemy.kind === "dreadnought" && enemy.hp > 0,
      ),
      epoch: this.scene.world.arenaEpoch,
      now,
      presenting:
        this.scene.live &&
        this.scene.started &&
        this.scene.spawned &&
        this.scene.alive &&
        !this.scene.paused &&
        !this.scene.frozen &&
        !this.scene.trailer,
    });
    this.scene.battleBackdrop.update(beat);
    sfx.setBattleBeat(beat);
  }

  private updateRecovery(now: number, presentation: boolean): void {
    const recovering =
      presentation && this.scene.spawned && !this.scene.alive && this.scene.respawnAt > 0;
    if (this.overlayEl) {
      this.overlayEl.hidden = !recovering;
      this.overlayEl.style.opacity = recovering ? "1" : "0";
    }
    // Hiding for recovery never changes the original recap expiry.
    if (this.recapEl) {
      this.recapEl.hidden = !presentation || recovering || now >= this.recapUntil;
    }
    if (this.pulseEl) {
      this.pulseEl.hidden = !presentation || recovering;
    }
    if (!recovering) {
      return;
    }
    const remaining = PhaserMath.Clamp(this.scene.respawnAt - now, 0, RESPAWN_DELAY_MS);
    const progress = 1 - remaining / RESPAWN_DELAY_MS;
    setText(this.causeEl, this.scene.shield.deathCause ? `— ${this.scene.shield.deathCause}` : "");
    setText(this.hintEl, this.scene.shield.deathHint);
    setText(this.countdownEl, `Re-entry in ${(remaining / 1000).toFixed(1)}s`);
    setText(
      this.recoveryLoadoutEl,
      `RETURN WITH LEVEL ${this.scene.progress.level} ${baseWeaponForLevel(this.scene.progress.level).name} + FULL SHIELD`,
    );
    if (this.recoveryFillEl) {
      this.recoveryFillEl.style.transform = `scaleX(${progress})`;
    }
    setAttribute(this.recoveryProgressEl, "aria-valuenow", String(Math.round(progress * 100)));
  }
}
