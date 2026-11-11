// The match: the `G.net` hooks strikeforce-core.js calls, and everything
// behind them.
//
// The room's host runs the rules (rules.ts) on its own clock and publishes the
// match at MATCH_HZ: phase, round clock, score, who is alive, where the charge
// is, which barrels stand. Every client — the host included — plays its own
// body, publishes it at BODY_HZ, and follows the published match: it respawns
// itself when a round starts, freezes in freeze time, spectates a teammate
// when dead. Hits favour the shooter: a client tests its shots against the
// avatars on its own screen and tells the host, which applies the damage and
// sends the victim a `hurt`. Area damage (barrels, the charge) each client
// applies to itself and reports through its body's health.
import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { GameState, NetHooks, StrikeforceGame, ShotHit, WeaponFire } from "../core/types";
import { ChargeProp } from "./charge";
import { buildMap, dressRelays } from "./map";
import type { End, MatchMap } from "./map";
import { MatchHud } from "./match-hud";
import { Players, callsignOf } from "./players";
import type { Opponent } from "./players";
import {
  BODY_HZ,
  EV,
  MATCH_HZ,
  MATCH_KEY,
  TEAM_NAME,
  decodeMatch,
  encodeMatch,
  q3,
} from "./protocol";
import {
  RULES,
  applyDefuse,
  applyHit,
  applyPlant,
  applySelfReport,
  newMatch,
  syncRoster,
  tick,
} from "./rules";
import type { Bodies, Fighter, MatchEvent, MatchState, Point, Team } from "./rules";
import { isRecord, isStr, nums, vecAt, vecWire } from "./wire";

/** A rifle headshot kills outright; anything else is the weapon's damage. */
const HEAD_MULTIPLIER = 4;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const inPlay = (state: GameState): boolean => state === "playing" || state === "paused";

/** Which end of the dock a team spawns at this round: attackers take the gate. */
const endOf = (m: MatchState, team: Team): End => (team === m.attack ? "gate" : "quay");

const remoteShot = (payload: JsonValue, game: StrikeforceGame): void => {
  const v = nums(payload, 7);
  if (!v) {
    return;
  }
  const muzzle = vecAt(v, 0, new Vector3());
  const end = vecAt(v, 3, new Vector3());
  const dir = new Vector3().subVectors(end, muzzle).normalize();
  game.fx.tracer(muzzle, end);
  game.fx.muzzleFlash(muzzle, dir, { scale: 0.8 });
  game.audio.play?.(v[6] === 1 ? "pistol_shot" : "rifle_shot", {
    gain: 0.55,
    jitter: 0.03,
    pos: muzzle,
  });
};

export class Match implements NetHooks {
  readonly match = true;
  private client: MultiplayerClient | null = null;
  private game: StrikeforceGame | null = null;
  private players: Players | null = null;
  private map: MatchMap | null = null;
  private charge: ChargeProp | null = null;
  private readonly hud = new MatchHud();
  /** The host's own rules state; null on a guest. */
  private rules: MatchState | null = null;
  /** The match as this client last read it. */
  private view: MatchState | null = null;
  private lastRaw: JsonValue | undefined = undefined;
  private seenState: GameState | null = null;
  private stateListener: ((state: GameState, game: StrikeforceGame) => void) | null = null;
  /** The round this body was last placed into. */
  private placedRound = -1;
  private holdMs = 0;
  private asked = false;
  private detonatedRound = -1;
  private spectating: string | null = null;
  private readonly matchRate = new FixedRate(MATCH_HZ);
  private readonly bodyRate = new FixedRate(BODY_HZ);
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  get guest(): boolean {
    return Boolean(this.client) && !this.isHost();
  }

  /** For the two-client harness and playtest diagnostics. */
  get state(): MatchState | null {
    return this.view;
  }

  get me(): string {
    return this.client?.playerId ?? "";
  }

  /** For playtest diagnostics: the sites, and where living enemies stand. */
  sites(): Point[] {
    return this.map?.sites ?? [];
  }

  enemies(): Point[] {
    const { view } = this;
    const mine = view?.roster.get(this.me);
    const out: Point[] = [];
    for (const p of this.players?.all.values() ?? []) {
      const f = view?.roster.get(p.id);
      if (p.pose && f?.alive && f.team !== mine?.team) {
        out.push(p.pose);
      }
    }
    return out;
  }

  /** Players in this room, us included. */
  get size(): number {
    return (this.players?.all.size ?? 0) + 1;
  }

  /** The room arrived (or went offline): start speaking. */
  connect(client: MultiplayerClient): void {
    this.client = client;
    client.onEvent = (event, payload, from) => this.onEvent(event, payload, from);
  }

  /**
   * Hear the game's flow change (title → playing → …), once per change,
   * starting with its state when it attaches. Register before booting.
   */
  watchState(listener: (state: GameState, game: StrikeforceGame) => void): void {
    this.stateListener = listener;
  }

  attach(game: StrikeforceGame): void {
    this.game = game;
    this.players = new Players(game, {
      joined: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> joined`),
      left: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> left`),
    });
    this.map = buildMap(game);
    this.charge = new ChargeProp(game);
    this.hud.mount();
    dressRelays(game);
    game.events.on("weapon:fire", (shot) => this.sendShot(shot));
    this.seenState = game.game.state;
    this.stateListener?.(game.game.state, game);
  }

  frame(dt: number): void {
    const { client, game, players } = this;
    if (!game || !players) {
      return;
    }
    this.watchFlow(game);
    if (!client) {
      return;
    }
    const { me } = this;
    const myTeam = this.view?.roster.get(me)?.team ?? null;
    players.update(client.players, me, myTeam, (id) => this.view?.roster.get(id) ?? null, dt);
    if (this.isHost()) {
      this.runHost(client, game, dt);
    } else {
      this.readMatch(client);
    }
    this.followMatch(game, dt);
    if (this.bodyRate.due(dt * 1000)) {
      this.publishBody(client, game);
    }
    this.hud.update({
      callsign: (id) => (id === me ? "You" : callsignOf(id)),
      match: this.view,
      me,
      now: client.serverNow(),
      status: client.connectionStatus,
      title: game.game.state === "title",
    });
  }

  shoot(origin: Vector3, dir: Vector3, maxDist: number, damage: number): ShotHit | null {
    const { view } = this;
    const roster = view?.roster;
    const mine = roster?.get(this.me);
    if (!this.players || !this.client || !mine?.alive) {
      return null;
    }
    const hit = this.players.hitTest(origin, dir, maxDist, (id) => {
      const f = roster?.get(id);
      return Boolean(f?.alive && f.team !== mine.team);
    });
    if (!hit) {
      return null;
    }
    const head = hit.part === "head";
    this.client.sendToHost(EV.hit, [
      hit.id,
      Math.round(damage * (head ? HEAD_MULTIPLIER : 1)),
      head ? 1 : 0,
    ]);
    return hit;
  }

  barrelHit(index: number, damage: number, point: Vector3 | null, dir: Vector3 | null): void {
    if (index >= 0) {
      this.client?.sendToHost(EV.barrel, [index, q3(damage), ...vecWire(point), ...vecWire(dir)]);
    }
  }

  // ---- host ----------------------------------------------------------------

  private isHost(): boolean {
    const c = this.client;
    return Boolean(c && (c.isHost || c.connectionStatus === "offline"));
  }

  /** Everyone's last reported position, ours included. */
  private bodies(game: StrikeforceGame): Bodies {
    const out = this.players?.bodies() ?? {};
    out[this.me] = { x: game.player.pos.x, y: game.player.pos.y, z: game.player.pos.z };
    return out;
  }

  private deployedIds(game: StrikeforceGame): string[] {
    const ids = [...(this.players?.all.values() ?? [])]
      .filter((p) => p.deployed && p.connected)
      .map((p) => p.id);
    if (inPlay(game.game.state)) {
      ids.push(this.me);
    }
    return ids;
  }

  private runHost(client: MultiplayerClient, game: StrikeforceGame, dt: number): void {
    // A guest promoted to host picks the match up where the last host left it.
    this.rules ??= this.view ?? newMatch();
    const { rules } = this;
    const now = client.serverNow();
    const bodies = this.bodies(game);
    syncRoster(rules, this.deployedIds(game), bodies);
    const events: MatchEvent[] = [];
    for (const p of this.players?.all.values() ?? []) {
      events.push(...applySelfReport(rules, p.id, p.hp, p.round, now, bodies));
    }
    events.push(
      ...applySelfReport(rules, this.me, game.player.health, this.placedRound, now, bodies),
      ...tick(rules, now, bodies, Math.random),
    );
    this.view = rules;
    this.hostEvents(client, game, events);
    if (this.matchRate.due(dt * 1000)) {
      client.updateSharedState({
        [MATCH_KEY]: { ...encodeMatch(rules, now), bar: game.explosives.aliveMask() },
      });
    }
  }

  private hostEvents(client: MultiplayerClient, game: StrikeforceGame, events: MatchEvent[]): void {
    for (const e of events) {
      if (e.kind === "kill") {
        const wire = [e.killer, e.victim, e.head ? 1 : 0];
        client.sendEvent(EV.kill, wire, { except: client.playerId ?? undefined });
        this.onKill(wire);
      } else if (e.kind === "round-start") {
        // Every round starts on a full dock.
        game.explosives.reset();
      }
    }
  }

  private applyIntent(
    event: string,
    payload: JsonValue,
    from: string,
    game: StrikeforceGame,
  ): void {
    const { rules, client, map } = this;
    if (!rules || !client || !map) {
      return;
    }
    const now = client.serverNow();
    const bodies = this.bodies(game);
    if (event === EV.hit) {
      const v = Array.isArray(payload) ? payload : [];
      const [victim, dmg, head] = v;
      if (!isStr(victim) || !Number.isFinite(dmg)) {
        return;
      }
      const result = applyHit(rules, from, victim, Number(dmg), head === 1, now, bodies);
      if (result) {
        this.hurt(victim, Number(dmg), bodies[from], result.hp);
        this.hostEvents(client, game, result.events);
      }
    } else if (event === EV.plant) {
      applyPlant(rules, from, Number(payload), map.sites, bodies, now);
    } else if (event === EV.defuse) {
      applyDefuse(rules, from, bodies, now);
    } else if (event === EV.barrel) {
      const v = nums(payload, 8);
      if (v) {
        game.explosives.netHit(v[0] ?? -1, v[1] ?? 0, v.slice(2, 5), v.slice(5, 8));
      }
    }
  }

  private hurt(
    victim: string,
    dmg: number,
    from: { x: number; y: number; z: number } | undefined,
    hp: number,
  ): void {
    const wire = [dmg, ...vecWire(from ? this.a.set(from.x, from.y, from.z) : null), hp];
    if (victim === this.me) {
      this.onHurt(wire);
    } else {
      this.client?.sendEvent(EV.hurt, wire, { to: victim });
    }
  }

  // ---- everyone ------------------------------------------------------------

  private readMatch(client: MultiplayerClient): void {
    const raw = client.sharedState[MATCH_KEY];
    if (raw === this.lastRaw) {
      return;
    }
    this.lastRaw = raw;
    this.rules = null;
    const decoded = decodeMatch(raw);
    if (decoded) {
      this.view = decoded.state;
    }
    if (isRecord(raw) && isStr(raw.bar) && this.game) {
      this.game.explosives.syncMask(raw.bar);
    }
  }

  private watchFlow(game: StrikeforceGame): void {
    const { state } = game.game;
    if (state === this.seenState) {
      return;
    }
    const was = this.seenState;
    this.seenState = state;
    if (was === "title" && state === "playing") {
      // Deployed: the next match read places us.
      this.placedRound = -1;
      dressRelays(game);
    }
    this.stateListener?.(state, game);
  }

  /** Put our body where the match says it is: placed, frozen, dead or free. */
  private followMatch(game: StrikeforceGame, dt: number): void {
    const m = this.view;
    const me = m?.roster.get(this.me);
    const { player } = game;
    if (!m || !me || !inPlay(game.game.state)) {
      this.charge?.update(
        m?.charge ?? { carrier: "", site: -1, state: "none", x: 0, y: 0, z: 0 },
        0,
        game,
      );
      return;
    }
    this.syncBody(game, m, me);
    this.announce(game, m);
    this.objective(game, m, me.team, dt);
    const left = (m.ends - (this.client?.serverNow() ?? 0)) / 1000;
    this.charge?.update(m.charge, left, game);
    this.detonate(game, m);
    if (!player.alive) {
      this.spectate(game, m, me.team);
    }
  }

  /** Respawn at a round start (or a warmup comeback), go down when the host says so, hold still in freeze time. */
  private syncBody(game: StrikeforceGame, m: MatchState, me: Fighter): void {
    const { player } = game;
    const fresh = m.round !== this.placedRound || (m.phase === "warmup" && !player.alive);
    if (fresh && me.alive) {
      this.place(game, m, me.team, me.slot);
    }
    if (!me.alive && player.alive && m.phase !== "warmup") {
      // The host says we are down (a hit we missed, or we joined mid-round).
      player.damage(9999);
    }
    player.enabled = m.phase !== "freeze";
  }

  private place(game: StrikeforceGame, m: MatchState, team: Team, slot: number): void {
    const spawns = this.map?.spawns[endOf(m, team)] ?? [];
    const spawn = spawns[slot % Math.max(1, spawns.length)];
    if (spawn) {
      game.player.reset({ pos: spawn.pos.clone(), yaw: spawn.yaw });
      game.weapon.reset();
    }
    this.placedRound = m.round;
    this.spectating = null;
    this.holdMs = 0;
    this.asked = false;
  }

  private prev: { phase: string; round: number; attack: Team } | null = null;

  private announce(game: StrikeforceGame, m: MatchState): void {
    const { prev } = this;
    this.prev = { attack: m.attack, phase: m.phase, round: m.round };
    if (!prev || (prev.phase === m.phase && prev.round === m.round)) {
      return;
    }
    const me = m.roster.get(this.me);
    const side = me && me.team === m.attack ? "Attack" : "Defend";
    if (m.phase === "freeze") {
      const swap = prev.attack !== m.attack && m.round > 1 ? " · sides switch" : "";
      game.hud.warn(`Round ${m.round} · ${side}${swap}`, 3);
    } else if (m.phase === "planted" && prev.phase === "live") {
      game.hud.warn(`Charge planted · site ${m.charge.site === 1 ? "B" : "A"}`, 3);
    } else if (m.phase === "post" && m.last) {
      game.hud.warn(`${TEAM_NAME[m.last.winner]} wins the round`, 3.4);
    } else if (m.phase === "over") {
      game.hud.warn(`${TEAM_NAME[m.score[0] > m.score[1] ? 0 : 1]} takes the match`, 5);
    } else if (m.phase === "warmup" && prev.phase !== "warmup") {
      game.hud.message("Warmup · waiting for both sides", 4);
    }
  }

  /** Objective line, site markers, and the hold-to-plant / hold-to-defuse prompt. */
  private objective(game: StrikeforceGame, m: MatchState, team: Team, dt: number): void {
    const { hud, player } = game;
    const { map } = this;
    if (!map) {
      return;
    }
    const attacking = team === m.attack;
    const carrying = m.charge.state === "carried" && m.charge.carrier === this.me;
    hud.setTally(`${attacking ? "Attack" : "Defend"} · ${TEAM_NAME[team]}`);
    hud.setObjective(this.objectiveText(m, attacking, carrying));
    const markers = map.sites.map((s, i) => ({
      id: i === 0 ? "site_a" : "site_b",
      kind: "relay" as const,
      label: `Site ${map.siteLabels[i] ?? ""}`,
      pos: new Vector3(s.x, s.y, s.z),
      short: i === 0 ? "A" : "B",
    }));
    const showCharge = m.charge.state === "planted" || (m.charge.state === "dropped" && attacking);
    if (showCharge) {
      markers.push({
        id: "charge",
        kind: "relay",
        label: "Charge",
        pos: new Vector3(m.charge.x, m.charge.y, m.charge.z),
        short: "C4",
      });
    }
    hud.setMarkers(markers);

    const action = this.availableAction(m, attacking, carrying, player.pos);
    if (!action || !player.alive) {
      this.holdMs = 0;
      hud.setPrompt(null);
      return;
    }
    const holding = game.input.down("interact") && player.vel.length() < 0.6;
    this.holdMs = holding ? this.holdMs + dt * 1000 : 0;
    const need = action.kind === "plant" ? RULES.plantMs : RULES.defuseMs;
    hud.setPrompt(action.label, Math.min(1, this.holdMs / need));
    if (this.holdMs >= need && !this.asked) {
      this.asked = true;
      this.client?.sendToHost(action.kind === "plant" ? EV.plant : EV.defuse, action.site);
    }
    if (!holding) {
      this.asked = false;
    }
  }

  private objectiveText(m: MatchState, attacking: boolean, carrying: boolean): string {
    if (m.phase === "warmup") {
      return this.size < 2 ? "Waiting for players" : "Warmup";
    }
    if (m.phase === "planted") {
      return attacking ? "Guard the charge" : "Defuse the charge";
    }
    if (attacking) {
      return carrying ? "Plant the charge at A or B" : "Get the charge to A or B";
    }
    return "Hold sites A and B";
  }

  private availableAction(
    m: MatchState,
    attacking: boolean,
    carrying: boolean,
    pos: Vector3,
  ): { kind: "plant" | "defuse"; label: string; site: number } | null {
    const { map } = this;
    if (!map) {
      return null;
    }
    if (m.phase === "live" && carrying) {
      const site = map.sites.findIndex(
        (s) => Math.hypot(s.x - pos.x, s.z - pos.z) <= RULES.siteRadius,
      );
      if (site === -1) {
        return null;
      }
      return { kind: "plant", label: `Plant at ${site === 0 ? "A" : "B"}`, site };
    }
    if (m.phase === "planted" && !attacking) {
      const near = Math.hypot(m.charge.x - pos.x, m.charge.z - pos.z) <= RULES.defuseRadius;
      return near ? { kind: "defuse", label: "Defuse", site: m.charge.site } : null;
    }
    return null;
  }

  /** The charge went off: the blast, and its damage to us, once per round. */
  private detonate(game: StrikeforceGame, m: MatchState): void {
    if (m.charge.state !== "detonated" || this.detonatedRound === m.round) {
      return;
    }
    this.detonatedRound = m.round;
    const at = this.b.set(m.charge.x, m.charge.y + 0.3, m.charge.z);
    game.fx.explosion(at.clone(), 3.2);
    const d = game.player.pos.distanceTo(at);
    const r = RULES.blastRadius;
    if (game.player.alive && d < r * 2) {
      game.player.damage(d <= r ? 9999 : 100 * (1 - (d - r) / r), at.clone());
    }
  }

  /** Dead: watch a living teammate over the shoulder (anyone, once the side is down). */
  private spectate(game: StrikeforceGame, m: MatchState, team: Team): void {
    const alive = (p: Opponent): boolean => Boolean(m.roster.get(p.id)?.alive && p.pose);
    const all = [...(this.players?.all.values() ?? [])];
    let target = all.find((p) => p.id === this.spectating && alive(p));
    target ??= all.find((p) => alive(p) && m.roster.get(p.id)?.team === team) ?? all.find(alive);
    this.spectating = target?.id ?? null;
    const pose = target?.pose;
    if (!pose) {
      return;
    }
    const back = this.a.set(Math.sin(pose.yaw), 0, Math.cos(pose.yaw)).multiplyScalar(2.6);
    game.camera.position.set(pose.x + back.x, pose.y + 2.1, pose.z + back.z);
    game.camera.lookAt(pose.x, pose.y + 1.4, pose.z);
  }

  private publishBody(client: MultiplayerClient, game: StrikeforceGame): void {
    const p = game.player;
    client.updateMyState({
      a: p.alive ? 1 : 0,
      c: p.crouching ? 1 : 0,
      d: inPlay(game.game.state) ? 1 : 0,
      hp: Math.round(p.health),
      pitch: q3(p.pitch),
      r: this.placedRound,
      t: Math.round(client.serverNow()),
      x: q3(p.pos.x),
      y: q3(p.pos.y),
      yaw: q3(p.yaw),
      z: q3(p.pos.z),
    });
  }

  private sendShot(shot: WeaponFire): void {
    const { client } = this;
    if (!client || !shot.muzzle || !shot.end) {
      return;
    }
    client.sendEvent(
      EV.shot,
      [...vecWire(shot.muzzle), ...vecWire(shot.end), shot.weapon === "pistol" ? 1 : 0],
      {
        except: client.playerId ?? undefined,
      },
    );
  }

  private onEvent(event: string, payload: JsonValue, from: string): void {
    const { game, client } = this;
    if (!game || !client) {
      return;
    }
    if (event === EV.shot && from !== client.playerId) {
      remoteShot(payload, game);
    } else if (event === EV.hurt) {
      const v = nums(payload, 5);
      if (v) {
        this.onHurt(v);
      }
    } else if (event === EV.kill) {
      this.onKill(Array.isArray(payload) ? payload : []);
    } else if (this.isHost()) {
      this.applyIntent(event, payload, from, game);
    }
  }

  private onHurt(v: readonly (number | string)[]): void {
    const { game } = this;
    const nv = v.map(Number);
    const dmg = nv[0] ?? 0;
    const hp = nv[4] ?? 0;
    if (!game?.player.alive) {
      return;
    }
    game.player.damage(dmg, vecAt(nv, 1, new Vector3()));
    // The host's count is the truth; never sit above it.
    if (game.player.health > hp) {
      game.player.damage(game.player.health - hp);
    }
  }

  private onKill(v: readonly JsonValue[]): void {
    const { game } = this;
    const [killer, victim, head] = v;
    if (!game || !isStr(killer) || !isStr(victim)) {
      return;
    }
    const name = (id: string): string => (id === this.me ? "You" : callsignOf(id));
    const by = killer ? `<b>${escapeHtml(name(killer))}</b> ` : "";
    this.feed(
      `${by}<em>${head === 1 ? "headshot" : "down"}</em> <b>${escapeHtml(name(victim))}</b>`,
    );
    if (killer === this.me && victim !== this.me) {
      game.combat.stats.kills += 1;
      game.hud.hitmarker("kill");
    }
  }

  private feed(html: string): void {
    this.game?.hud.feed(html);
  }
}
