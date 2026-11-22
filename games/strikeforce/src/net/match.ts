import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { GameState, NetHooks, StrikeforceGame, ShotHit, WeaponFire } from "../core/types";
import type { Combatant, Shot } from "../soldier/soldier-brain";
import { showShot } from "../soldier/gunfire";
import { Radar } from "../minimap";
import { Bots, botPlayers } from "./bots";
import { arenaSpawns, darkenRelays, safestSpawn } from "./map";
import type { Spawn } from "./map";
import { MatchHud } from "./match-hud";
import { Players, callsignOf } from "./players";
import {
  BODY_HZ,
  BOTS_KEY,
  EV,
  MATCH_HZ,
  MATCH_KEY,
  decodeMatch,
  encodeMatch,
  q3,
} from "./protocol";
import {
  RULES,
  applyHit,
  applySelfReport,
  botSeats,
  isBot,
  newMatch,
  standings,
  syncRoster,
  tick,
} from "./rules";
import type { Fighter, MatchEvent, MatchState, Point } from "./rules";
import { isRecord, isStr, nums, vecAt, vecWire } from "./wire";

const HEAD_MULTIPLIER = 4;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const inPlay = (state: GameState) => state === "playing" || state === "paused";

const online = (game: StrikeforceGame | null) => game?.game.run.mode === "deathmatch";

const inMatch = (game: StrikeforceGame) => inPlay(game.game.state) && online(game);

/** Opens the room (session.ts), once, when the player first deploys online. */
export type Connector = () => Promise<MultiplayerClient>;

export interface MatchOptions {
  /** Fighters the host tops the dock up to with bots (0: no bots). */
  botFill: number;
}

const relayMarks = (game: StrikeforceGame) =>
  game.game.run.relays
    .filter((r) => !r.cut)
    .map((r) => ({ label: r.id.slice(-1).toUpperCase(), x: r.o.pos.x, z: r.o.pos.z }));

const remoteShot = (payload: JsonValue, game: StrikeforceGame, players: Players | null) => {
  const v = nums(payload, 7);

  if (!v) {
    return;
  }

  const muzzle = vecAt(v, 0, new Vector3());
  players?.fired(muzzle);
  showShot(game, muzzle, vecAt(v, 3, new Vector3()));
  game.audio.play?.(v[6] === 1 ? "pistol_shot" : "rifle_shot", {
    gain: 0.55,
    jitter: 0.03,
    pos: muzzle,
  });
};

export class Match implements NetHooks {
  /** The core's mission flow stands down while the deployed mode is online. */
  get match() {
    return online(this.game);
  }
  private readonly connector: Connector;
  private readonly botFill: number;
  private bots: Bots | null = null;
  private botRaw: JsonValue | undefined = undefined;
  private joining = false;
  private client: MultiplayerClient | null = null;
  private game: StrikeforceGame | null = null;
  private players: Players | null = null;
  private spawns: Spawn[] = [];
  private readonly hud = new MatchHud();
  private readonly radar = new Radar();
  private rules: MatchState | null = null;
  private view: MatchState | null = null;
  private lastRaw: JsonValue | undefined = undefined;
  private seenState: GameState | null = null;
  private stateListener: ((state: GameState, game: StrikeforceGame) => void) | null = null;
  private placedLife = -1;
  private seenRound = -1;
  private seenPhase = "";
  private readonly matchRate = new FixedRate(MATCH_HZ);
  private readonly bodyRate = new FixedRate(BODY_HZ);
  private readonly botRate = new FixedRate(BODY_HZ);
  private readonly a = new Vector3();

  /**
   * In a match every barrel is the host's: a guest's shot is only a request.
   * When the host is not in the match itself (title, solo PvE) it applies no
   * requests and publishes no barrels, so they stand for everyone rather than
   * blowing differently on each guest's dock. Solo PvE keeps its own barrels.
   */
  get guest() {
    return Boolean(this.client) && !this.isHost() && this.match;
  }

  /** For the two-client harness and playtest diagnostics. */
  get state() {
    return this.view;
  }

  get me() {
    return this.client?.playerId ?? "";
  }

  /** Where every living enemy stands (spawning, playtest diagnostics). */
  enemies() {
    const out: Point[] = [];

    for (const p of this.players?.all.values() ?? []) {
      if (p.pose && this.view?.roster.get(p.id)?.alive) {
        out.push(p.pose);
      }
    }

    return out;
  }

  /** Players in this room, us included. */
  get size() {
    return (this.players?.all.size ?? 0) + 1;
  }

  constructor(connector: Connector, options: MatchOptions) {
    this.connector = connector;
    this.botFill = options.botFill;
  }

  private async connect() {
    if (this.client || this.joining) {
      return;
    }

    this.joining = true;
    const client = await this.connector();
    client.onEvent = (event, payload, from) => this.onEvent(event, payload, from);
    this.client = client;
  }

  /**
   * Hear the game's flow change (title → playing → …), once per change,
   * starting with its state when it attaches. Register before booting.
   */
  watchState(listener: (state: GameState, game: StrikeforceGame) => void) {
    this.stateListener = listener;
  }

  attach(game: StrikeforceGame) {
    this.game = game;
    this.players = new Players(game, {
      joined: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> joined`),
      left: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> left`),
    });
    this.spawns = arenaSpawns(game);
    this.bots = new Bots(game, this.spawns);
    this.hud.mount();
    this.radar.mount();
    game.events.on("weapon:fire", (shot) => this.sendShot(shot));
    this.seenState = game.game.state;
    this.stateListener?.(game.game.state, game);
  }

  frame(dt: number) {
    const { client, game, players } = this;

    if (!game || !players) {
      return;
    }

    this.watchFlow(game);
    this.radar.update(game, game.game.state === "playing", online(game) ? [] : relayMarks(game));

    if (!client) {
      return;
    }

    const { me, view } = this;
    const everyone = { ...client.players, ...botPlayers(this.botRaw, view?.roster) };
    players.update(everyone, me, (id) => view?.roster.get(id) ?? null, dt);

    if (!inMatch(game)) {
      players.hide();
    }

    if (this.isHost()) {
      this.runHost(client, game, dt);
    } else {
      this.readMatch(client);
      this.botRaw = client.sharedState[BOTS_KEY];
    }

    this.followMatch(game);

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

  shoot(origin: Vector3, dir: Vector3, maxDist: number, damage: number) {
    const roster = this.view?.roster;

    if (!this.players || !this.client || !roster?.get(this.me)?.alive || !this.game) {
      return null satisfies ShotHit | null;
    }

    if (!inMatch(this.game)) {
      return null satisfies ShotHit | null;
    }

    const hit = this.players.hitTest(origin, dir, maxDist, (id) => Boolean(roster.get(id)?.alive));

    if (!hit) {
      return null satisfies ShotHit | null;
    }

    const head = hit.part === "head";
    this.client.sendToHost(EV.hit, [
      hit.id,
      Math.round(damage * (head ? HEAD_MULTIPLIER : 1)),
      head ? 1 : 0,
    ]);

    return hit satisfies ShotHit | null;
  }

  barrelHit(index: number, damage: number, point: Vector3 | null, dir: Vector3 | null) {
    if (index >= 0) {
      this.client?.sendToHost(EV.barrel, [index, q3(damage), ...vecWire(point), ...vecWire(dir)]);
    }
  }

  private isHost() {
    const c = this.client;

    return Boolean(c && (c.isHost || c.connectionStatus === "offline"));
  }

  private bodyOf(id: string, game: StrikeforceGame) {
    return id === this.me ? game.player.pos : (this.players?.all.get(id)?.reported ?? undefined);
  }

  private deployedIds(game: StrikeforceGame) {
    const ids = [...(this.players?.all.values() ?? [])].flatMap((p) =>
      p.deployed && !isBot(p.id) ? [p.id] : [],
    );

    if (inMatch(game)) {
      ids.push(this.me);
    }

    return ids;
  }

  private runHost(client: MultiplayerClient, game: StrikeforceGame, dt: number) {
    this.rules ??= this.view ?? newMatch();
    const { rules } = this;
    const now = client.serverNow();
    const humans = this.deployedIds(game);
    syncRoster(rules, [...humans, ...botSeats(humans.length, this.botFill)]);
    const events: MatchEvent[] = [];

    for (const p of this.players?.all.values() ?? []) {
      if (!isBot(p.id)) {
        events.push(...applySelfReport(rules, p.id, p.hp, p.life, now));
      }
    }

    events.push(
      ...applySelfReport(rules, this.me, game.player.health, this.placedLife, now),
      ...tick(rules, now),
    );
    this.view = rules;
    this.hostEvents(client, game, events);
    this.runBots(client, game, rules, dt);

    if (this.matchRate.due(dt * 1000)) {
      client.updateSharedState({
        [MATCH_KEY]: inMatch(game)
          ? { ...encodeMatch(rules, now), bar: game.explosives.aliveMask() }
          : encodeMatch(rules, now),
      });
    }
  }

  private runBots(client: MultiplayerClient, game: StrikeforceGame, rules: MatchState, dt: number) {
    if (!this.bots) {
      return;
    }

    this.bots.update(
      dt,
      rules.roster,
      this.peopleStanding(game, rules),
      (id) => this.players?.all.get(id)?.reported ?? undefined,
      rules.phase === "live",
      (shot) => this.botShot(client, game, shot),
    );
    const raw = this.bots.encode(client.serverNow());
    this.botRaw = raw;

    if (this.botRate.due(dt * 1000)) {
      client.updateSharedState({ [BOTS_KEY]: raw });
    }
  }

  private peopleStanding(game: StrikeforceGame, rules: MatchState) {
    const out: Combatant[] = [];
    const { player } = game;

    if (inMatch(game) && player.alive && rules.roster.get(this.me)?.alive) {
      out.push({
        crouch: player.crouching,
        id: this.me,
        moving: Math.hypot(player.vel.x, player.vel.z) > 2,
        pos: player.pos,
      });
    }

    for (const p of this.players?.all.values() ?? []) {
      if (!isBot(p.id) && p.reported && rules.roster.get(p.id)?.alive) {
        out.push({ crouch: (p.pose?.crouch ?? 0) > 0.5, id: p.id, moving: true, pos: p.reported });
      }
    }

    return out;
  }

  private botShot(client: MultiplayerClient, game: StrikeforceGame, shot: Shot) {
    const wire = [...vecWire(shot.muzzle), ...vecWire(shot.end), 0];
    client.sendEvent(EV.shot, wire, { except: client.playerId ?? undefined });

    if (inMatch(game)) {
      remoteShot(wire, game, this.players);
      this.radar.ping(shot.muzzle.x, shot.muzzle.z, game.time.t);
    }

    const { rules } = this;

    if (!rules || !shot.victim) {
      return;
    }

    const result = applyHit(
      rules,
      shot.shooter,
      shot.victim,
      shot.damage,
      shot.head,
      client.serverNow(),
    );

    if (result) {
      this.hurt(shot.victim, shot.damage, shot.muzzle, result.hp);
      this.hostEvents(client, game, result.events);
    }
  }

  private hostEvents(client: MultiplayerClient, game: StrikeforceGame, events: MatchEvent[]) {
    for (const e of events) {
      if (e.kind === "kill") {
        const wire = [e.killer, e.victim, e.head ? 1 : 0];
        client.sendEvent(EV.kill, wire, { except: client.playerId ?? undefined });
        this.onKill(wire);
      } else if (e.kind === "start") {
        game.explosives.reset();
      }
    }
  }

  private applyIntent(event: string, payload: JsonValue, from: string, game: StrikeforceGame) {
    const { rules, client } = this;

    if (!rules || !client) {
      return;
    }

    if (event === EV.hit) {
      const v = Array.isArray(payload) ? payload : [];
      const [victim, dmg, head] = v;

      if (!isStr(victim) || !Number.isFinite(dmg)) {
        return;
      }

      const now = client.serverNow();
      const result = applyHit(rules, from, victim, Number(dmg), head === 1, now);

      if (result) {
        this.hurt(victim, Number(dmg), this.bodyOf(from, game), result.hp);
        this.hostEvents(client, game, result.events);
      }
    } else if (event === EV.barrel) {
      const v = nums(payload, 8);

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
  ) {
    if (isBot(victim)) {
      this.bots?.alert(victim, from);

      return;
    }

    const wire = [dmg, ...vecWire(from ? this.a.set(from.x, from.y, from.z) : null), hp];

    if (victim === this.me) {
      this.onHurt(wire);
    } else {
      this.client?.sendEvent(EV.hurt, wire, { to: victim });
    }
  }

  private readMatch(client: MultiplayerClient) {
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

  private watchFlow(game: StrikeforceGame) {
    const { state } = game.game;

    if (state === this.seenState) {
      return;
    }

    const was = this.seenState;
    this.seenState = state;

    if (was === "title" && inPlay(state) && online(game)) {
      this.placedLife = -1;
      darkenRelays(game);
      void this.connect();
    }

    this.stateListener?.(state, game);
  }

  private followMatch(game: StrikeforceGame) {
    const m = this.view;
    const me = m?.roster.get(this.me);

    if (!inMatch(game) || !m || !me) {
      return;
    }

    this.syncBody(game, me);
    this.announce(game, m);
    this.objective(game, m);
  }

  private syncBody(game: StrikeforceGame, me: Fighter) {
    const { player } = game;

    if (me.alive && me.life !== this.placedLife) {
      this.place(game, me);
    }

    if (!me.alive && player.alive && me.life === this.placedLife) {
      player.damage(9999);
    }

    player.enabled = true;
  }

  private place(game: StrikeforceGame, me: Fighter) {
    const spawn = safestSpawn(this.spawns, this.enemies());

    if (spawn) {
      game.player.reset({ pos: spawn.pos.clone(), yaw: spawn.yaw });
      game.weapon.reset();
    }

    this.placedLife = me.life;
  }

  private announce(game: StrikeforceGame, m: MatchState) {
    if (m.phase === this.seenPhase && m.round === this.seenRound) {
      return;
    }

    const first = this.seenPhase === "";
    this.seenPhase = m.phase;
    this.seenRound = m.round;

    if (m.phase === "live" && !first) {
      game.hud.warn(`Deathmatch · first to ${RULES.kills}`, 3);
    } else if (m.phase === "over") {
      const who = m.champ === this.me ? "You win" : `${callsignOf(m.champ)} wins`;
      game.hud.warn(`${who} the match`, 5);
    } else if (m.phase === "warmup") {
      game.hud.message("Warmup · waiting for another player", 4);
    }
  }

  private objective(game: StrikeforceGame, m: MatchState) {
    const kills = m.roster.get(this.me)?.kills ?? 0;
    const place = standings(m).findIndex(([id]) => id === this.me);
    game.hud.setTally(`${kills} kills · ${place <= 0 ? "leading" : `#${place + 1}`}`);
    game.hud.setObjective(
      m.phase === "warmup" ? "Waiting for a rival" : `First to ${RULES.kills} kills`,
    );
    game.hud.setMarkers([]);
    game.hud.setPrompt(null);
  }

  private publishBody(client: MultiplayerClient, game: StrikeforceGame) {
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

  private sendShot(shot: WeaponFire) {
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

  private onEvent(event: string, payload: JsonValue, from: string) {
    const { game, client } = this;

    if (!game || !client) {
      return;
    }

    const playing = inMatch(game);

    if (event === EV.shot && from !== client.playerId) {
      const v = nums(payload, 3);

      if (playing && v) {
        remoteShot(payload, game, this.players);
        this.radar.ping(v[0] ?? 0, v[2] ?? 0, game.time.t);
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

  private onHurt(v: readonly (number | string)[]) {
    const { game } = this;
    const nv = v.map(Number);
    const dmg = nv[0] ?? 0;
    const hp = nv[4] ?? 0;

    if (!game?.player.alive) {
      return;
    }

    game.player.damage(dmg, vecAt(nv, 1, new Vector3()));

    if (game.player.health > hp) {
      game.player.damage(game.player.health - hp);
    }
  }

  private onKill(v: readonly JsonValue[]) {
    const { game } = this;
    const [killer, victim, head] = v;

    if (!game || !isStr(killer) || !isStr(victim)) {
      return;
    }

    const name = (id: string) => (id === this.me ? "You" : callsignOf(id));
    const by = killer ? `<b>${escapeHtml(name(killer))}</b> ` : "";
    this.feed(
      `${by}<em>${head === 1 ? "headshot" : "down"}</em> <b>${escapeHtml(name(victim))}</b>`,
    );
    const from = killer ? this.bodyOf(killer, game) : undefined;

    if (from) {
      this.players?.felled(victim, from, head === 1);
    }

    if (killer === this.me && victim !== this.me) {
      game.combat.stats.kills += 1;
      game.hud.hitmarker("kill");
    }
  }

  private feed(html: string) {
    this.game?.hud.feed(html);
  }
}
