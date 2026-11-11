// The match: the `G.net` hooks strikeforce-core.js calls, and everything
// behind them.
//
// A tab joins a room only when it deploys into an online mode (deathmatch or
// 8v8 rounds; one lobby each), so solo PvE never shares anything. The room's
// host runs the rules (rules.ts) on its own clock and publishes the match at
// MATCH_HZ: phase, clock, score, who is alive, where the charge is, which
// barrels stand. Every client — the host included — plays its own body,
// publishes it at BODY_HZ, and follows the published match: it places itself
// whenever the host brings its fighter back (a new `life`), freezes in freeze
// time, and in rounds spectates a teammate when dead. Hits favour the shooter: a client tests its shots against the
// avatars on its own screen and tells the host, which applies the damage and
// sends the victim a `hurt`. Area damage (barrels, the charge) each client
// applies to itself and reports through its body's health.
import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { GameState, NetHooks, StrikeforceGame, ShotHit, WeaponFire } from "../core/types";
import { ChargeProp } from "./charge";
import { buildMap, dressRelays } from "./map";
import type { End, MatchMap, Spawn } from "./map";
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
import type { OnlineMode } from "./protocol";
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
import type { Bodies, Fighter, MatchEvent, MatchKind, MatchState, Point, Team } from "./rules";
import { isRecord, isStr, nums, vecAt, vecWire } from "./wire";

/** A rifle headshot kills outright; anything else is the weapon's damage. */
const HEAD_MULTIPLIER = 4;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const inPlay = (state: GameState): boolean => state === "playing" || state === "paused";

/** The online mode the title is set to (or deployed in), or null for solo PvE. */
const onlineMode = (game: StrikeforceGame | null): OnlineMode | null => {
  const mode = game?.game.run.mode;
  return mode === "match" || mode === "deathmatch" ? mode : null;
};

/** Deployed into an online mode (not the title, not a solo PvE mode). */
const inMatch = (game: StrikeforceGame): boolean =>
  inPlay(game.game.state) && onlineMode(game) !== null;

/** Opens the room for a mode (session.ts), once, when the player deploys. */
export type Connector = (mode: OnlineMode) => Promise<MultiplayerClient>;

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
  /** The core's mission flow stands down while the deployed mode is online. */
  get match(): boolean {
    return onlineMode(this.game) !== null;
  }
  private readonly connector: Connector;
  private joining = false;
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
  /** The life (rules.ts) this body was last placed as. */
  private placedLife = -1;
  private holdMs = 0;
  private asked = false;
  private detonatedRound = -1;
  private spectating: string | null = null;
  private readonly matchRate = new FixedRate(MATCH_HZ);
  private readonly bodyRate = new FixedRate(BODY_HZ);
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  /**
   * In a match every barrel is the host's: a guest's shot is only a request.
   * When the host is not in the match itself (title, solo PvE) it applies no
   * requests and publishes no barrels, so they stand for everyone rather than
   * blowing differently on each guest's dock. Solo PvE keeps its own barrels.
   */
  get guest(): boolean {
    return Boolean(this.client) && !this.isHost() && this.match;
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
      if (p.pose && f?.alive && (view?.kind === "dm" || f.team !== mine?.team)) {
        out.push(p.pose);
      }
    }
    return out;
  }

  /** Players in this room, us included. */
  get size(): number {
    return (this.players?.all.size ?? 0) + 1;
  }

  constructor(connector: Connector) {
    this.connector = connector;
  }

  /** Deployed into an online mode: open its room (once per page). */
  private async join(mode: OnlineMode): Promise<void> {
    if (this.client || this.joining) {
      return;
    }
    this.joining = true;
    const client = await this.connector(mode);
    client.onEvent = (event, payload, from) => this.onEvent(event, payload, from);
    this.client = client;
  }

  private kind(): MatchKind {
    return onlineMode(this.game) === "deathmatch" ? "dm" : "rounds";
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
    const { me, view } = this;
    // Deathmatch has no sides: everyone wears one colour and nobody is a teammate.
    const dm = view?.kind === "dm";
    const myTeam = dm ? null : (view?.roster.get(me)?.team ?? null);
    const seat = (id: string): { team: Team; alive: boolean } | null => {
      const f = view?.roster.get(id);
      return f ? { alive: f.alive, team: dm ? 0 : f.team } : null;
    };
    players.update(client.players, me, myTeam, seat, dt);
    if (!inMatch(game)) {
      // Solo PvE (or the title): the room's players stay out of this dock.
      players.hide();
    }
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
      title: !inMatch(game),
    });
  }

  shoot(origin: Vector3, dir: Vector3, maxDist: number, damage: number): ShotHit | null {
    const { view } = this;
    const roster = view?.roster;
    const mine = roster?.get(this.me);
    if (!this.players || !this.client || !mine?.alive || !this.game || !inMatch(this.game)) {
      return null;
    }
    const dm = view?.kind === "dm";
    const hit = this.players.hitTest(origin, dir, maxDist, (id) => {
      const f = roster?.get(id);
      return Boolean(f?.alive && (dm || f.team !== mine.team));
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
      // A dropped connection keeps its seat for the SDK's reconnect grace: only
      // leaving the room (gone from client.players) gives it up.
      .filter((p) => p.deployed)
      .map((p) => p.id);
    if (inMatch(game)) {
      ids.push(this.me);
    }
    return ids;
  }

  private runHost(client: MultiplayerClient, game: StrikeforceGame, dt: number): void {
    // A guest promoted to host picks the match up where the last host left it.
    this.rules ??= this.view ?? newMatch(this.kind());
    const { rules } = this;
    const now = client.serverNow();
    const bodies = this.bodies(game);
    syncRoster(rules, this.deployedIds(game), bodies);
    const events: MatchEvent[] = [];
    for (const p of this.players?.all.values() ?? []) {
      events.push(...applySelfReport(rules, p.id, p.hp, p.life, now, bodies));
    }
    events.push(
      ...applySelfReport(rules, this.me, game.player.health, this.placedLife, now, bodies),
      ...tick(rules, now, bodies, Math.random),
    );
    this.view = rules;
    this.hostEvents(client, game, events);
    if (this.matchRate.due(dt * 1000)) {
      client.updateSharedState({
        [MATCH_KEY]: inMatch(game)
          ? { ...encodeMatch(rules, now), bar: game.explosives.aliveMask() }
          : encodeMatch(rules, now),
      });
    }
  }

  private hostEvents(client: MultiplayerClient, game: StrikeforceGame, events: MatchEvent[]): void {
    for (const e of events) {
      if (e.kind === "kill") {
        const wire = [e.killer, e.victim, e.head ? 1 : 0];
        client.sendEvent(EV.kill, wire, { except: client.playerId ?? undefined });
        this.onKill(wire);
      } else if (e.kind === "round-start" || e.kind === "dm-end") {
        // Every round, and every deathmatch, starts on a full dock.
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
      // Only a host on the same dock as the match owns its barrels.
      if (v && inMatch(game)) {
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
    if (isRecord(raw) && isStr(raw.bar) && this.game && this.match) {
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
    const mode = onlineMode(game);
    if (was === "title" && inPlay(state) && mode) {
      // Deployed online: join the mode's room; the first match read places us.
      this.placedLife = -1;
      dressRelays(game, mode === "match");
      void this.join(mode);
    }
    this.stateListener?.(state, game);
  }

  /** Put our body where the match says it is: placed, frozen, dead or free. */
  private followMatch(game: StrikeforceGame, dt: number): void {
    const m = this.view;
    const me = m?.roster.get(this.me);
    const { player } = game;
    if (!inMatch(game)) {
      this.charge?.hide();
      return;
    }
    if (!m || !me) {
      this.charge?.update(
        m?.charge ?? { carrier: "", site: -1, state: "none", x: 0, y: 0, z: 0 },
        0,
        game,
      );
      return;
    }
    this.syncBody(game, m, me);
    this.announce(game, m);
    if (m.kind === "dm") {
      this.objectiveDm(game, m);
    } else {
      this.objective(game, m, me.team, dt);
    }
    const left = (m.ends - (this.client?.serverNow() ?? 0)) / 1000;
    this.charge?.update(m.charge, left, game);
    this.detonate(game, m);
    if (!player.alive && m.kind === "rounds") {
      this.spectate(game, m, me.team);
    }
  }

  /**
   * Place the body whenever the host brings our fighter back (a new life: a
   * round start, a respawn), go down when the host says so, hold still in
   * freeze time.
   */
  private syncBody(game: StrikeforceGame, m: MatchState, me: Fighter): void {
    const { player } = game;
    if (me.alive && me.life !== this.placedLife) {
      this.place(game, m, me);
    }
    if (!me.alive && player.alive && me.life === this.placedLife) {
      // The host says we are down (a hit we missed, or we joined mid-round).
      player.damage(9999);
    }
    player.enabled = m.phase !== "freeze";
  }

  private place(game: StrikeforceGame, m: MatchState, me: Fighter): void {
    const spawn = m.kind === "dm" ? this.safestSpawn() : this.teamSpawn(m, me);
    if (spawn) {
      game.player.reset({ pos: spawn.pos.clone(), yaw: spawn.yaw });
      game.weapon.reset();
    }
    this.placedLife = me.life;
    this.spectating = null;
    this.holdMs = 0;
    this.asked = false;
  }

  private teamSpawn(m: MatchState, me: Fighter): Spawn | undefined {
    const spawns = this.map?.spawns[endOf(m, me.team)] ?? [];
    return spawns[me.slot % Math.max(1, spawns.length)];
  }

  /** Deathmatch: of a few random arena points, the one farthest from any enemy. */
  private safestSpawn(): Spawn | undefined {
    const arena = this.map?.arena ?? [];
    const foes = this.enemies();
    let best: Spawn | undefined;
    let bestD = -1;
    for (let i = 0; i < 6 && arena.length > 0; i += 1) {
      const spot = arena[Math.floor(Math.random() * arena.length)];
      if (!spot) {
        continue;
      }
      let nearest = Infinity;
      for (const f of foes) {
        nearest = Math.min(nearest, Math.hypot(f.x - spot.pos.x, f.z - spot.pos.z));
      }
      if (nearest > bestD) {
        bestD = nearest;
        best = spot;
      }
    }
    return best;
  }

  private prev: { phase: string; round: number; attack: Team } | null = null;

  private announce(game: StrikeforceGame, m: MatchState): void {
    const { prev } = this;
    this.prev = { attack: m.attack, phase: m.phase, round: m.round };
    if (!prev || (prev.phase === m.phase && prev.round === m.round)) {
      return;
    }
    if (m.kind === "dm") {
      this.announceDm(game, m);
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

  private announceDm(game: StrikeforceGame, m: MatchState): void {
    if (m.phase === "live") {
      game.hud.warn(`Deathmatch · first to ${RULES.dmKills}`, 3);
    } else if (m.phase === "over") {
      const who = m.champ === this.me ? "You win" : `${callsignOf(m.champ)} wins`;
      game.hud.warn(`${who} the deathmatch`, 5);
    } else if (m.phase === "warmup") {
      game.hud.message("Warmup · waiting for another player", 4);
    }
  }

  /** Deathmatch objective: kills and standing; no sites, no prompt. */
  private objectiveDm(game: StrikeforceGame, m: MatchState): void {
    const mine = m.roster.get(this.me);
    const kills = mine?.kills ?? 0;
    const ahead = [...m.roster.values()].filter((f) => f.kills > kills).length;
    game.hud.setTally(`${kills} kills · ${ahead === 0 ? "leading" : `#${ahead + 1}`}`);
    game.hud.setObjective(
      m.phase === "warmup" ? "Waiting for a rival" : `First to ${RULES.dmKills} kills`,
    );
    game.hud.setMarkers([]);
    game.hud.setPrompt(null);
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
      d: inMatch(game) ? 1 : 0,
      hp: Math.round(p.health),
      l: this.placedLife,
      pitch: q3(p.pitch),
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
    const playing = inMatch(game);
    if (event === EV.shot && from !== client.playerId) {
      if (playing) {
        remoteShot(payload, game);
      }
    } else if (event === EV.hurt) {
      const v = nums(payload, 5);
      if (v && playing) {
        this.onHurt(v);
      }
    } else if (event === EV.kill) {
      if (playing) {
        this.onKill(Array.isArray(payload) ? payload : []);
      }
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
