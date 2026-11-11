// The deathmatch: the `G.net` hooks strikeforce-core.js calls, and everything
// behind them.
//
// A tab joins a room only when it deploys into deathmatch, so solo PvE never
// shares anything. The room's host runs the rules (rules.ts) on its own clock
// and publishes the match at MATCH_HZ: phase, clock, kills, who is alive,
// which barrels stand. Every client — the host included — plays its own body,
// publishes it at BODY_HZ, and follows the published match: it places itself,
// at the spawn farthest from its enemies, whenever the host brings its fighter
// back (a new `life`). Hits favour the shooter: a client tests its shots
// against the avatars on its own screen and tells the host, which applies the
// damage and sends the victim a `hurt`. Area damage (barrels) each client
// applies to itself and reports through its body's health.
import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { GameState, NetHooks, StrikeforceGame, ShotHit, WeaponFire } from "../core/types";
import { Radar } from "../minimap";
import type { RadarMark } from "../minimap";
import { arenaSpawns, darkenRelays, safestSpawn } from "./map";
import type { Spawn } from "./map";
import { MatchHud } from "./match-hud";
import { Players, callsignOf } from "./players";
import { BODY_HZ, EV, MATCH_HZ, MATCH_KEY, decodeMatch, encodeMatch, q3 } from "./protocol";
import { RULES, applyHit, applySelfReport, newMatch, standings, syncRoster, tick } from "./rules";
import type { Fighter, MatchEvent, MatchState, Point } from "./rules";
import { isRecord, isStr, nums, vecAt, vecWire } from "./wire";

/** A rifle headshot kills outright; anything else is the weapon's damage. */
const HEAD_MULTIPLIER = 4;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const inPlay = (state: GameState): boolean => state === "playing" || state === "paused";

/** The title is set to (or deployed in) deathmatch, not a solo PvE mode. */
const online = (game: StrikeforceGame | null): boolean => game?.game.run.mode === "deathmatch";

/** Deployed into deathmatch (not the title, not a solo PvE mode). */
const inMatch = (game: StrikeforceGame): boolean => inPlay(game.game.state) && online(game);

/** Opens the room (session.ts), once, when the player first deploys online. */
export type Connector = () => Promise<MultiplayerClient>;

/** Solo modes: the relays still standing ("relay_a" → "A"). */
const relayMarks = (game: StrikeforceGame): RadarMark[] =>
  game.game.run.relays
    .filter((r) => !r.cut)
    .map((r) => ({ label: r.id.slice(-1).toUpperCase(), x: r.o.pos.x, z: r.o.pos.z }));

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
    return online(this.game);
  }
  private readonly connector: Connector;
  private joining = false;
  private client: MultiplayerClient | null = null;
  private game: StrikeforceGame | null = null;
  private players: Players | null = null;
  private spawns: Spawn[] = [];
  private readonly hud = new MatchHud();
  private readonly radar = new Radar();
  /** The host's own rules state; null on a guest. */
  private rules: MatchState | null = null;
  /** The match as this client last read it. */
  private view: MatchState | null = null;
  private lastRaw: JsonValue | undefined = undefined;
  private seenState: GameState | null = null;
  private stateListener: ((state: GameState, game: StrikeforceGame) => void) | null = null;
  /** The life (rules.ts) this body was last placed as. */
  private placedLife = -1;
  private seenRound = -1;
  private seenPhase = "";
  private readonly matchRate = new FixedRate(MATCH_HZ);
  private readonly bodyRate = new FixedRate(BODY_HZ);
  private readonly a = new Vector3();

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

  /** Where every living enemy stands (spawning, playtest diagnostics). */
  enemies(): Point[] {
    const out: Point[] = [];
    for (const p of this.players?.all.values() ?? []) {
      if (p.pose && this.view?.roster.get(p.id)?.alive) {
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

  /** Deployed online: open the room (once per page). */
  private async connect(): Promise<void> {
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
  watchState(listener: (state: GameState, game: StrikeforceGame) => void): void {
    this.stateListener = listener;
  }

  attach(game: StrikeforceGame): void {
    this.game = game;
    this.players = new Players(game, {
      joined: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> joined`),
      left: (p) => this.feed(`<b>${escapeHtml(p.callsign)}</b> left`),
    });
    this.spawns = arenaSpawns(game);
    this.hud.mount();
    this.radar.mount();
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
    this.radar.update(game, game.game.state === "playing", online(game) ? [] : relayMarks(game));
    if (!client) {
      return;
    }
    const { me, view } = this;
    players.update(client.players, me, (id) => view?.roster.get(id) ?? null, dt);
    if (!inMatch(game)) {
      // Solo PvE (or the title): the room's players stay out of this dock.
      players.hide();
    }
    if (this.isHost()) {
      this.runHost(client, game, dt);
    } else {
      this.readMatch(client);
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

  shoot(origin: Vector3, dir: Vector3, maxDist: number, damage: number): ShotHit | null {
    const roster = this.view?.roster;
    if (!this.players || !this.client || !roster?.get(this.me)?.alive || !this.game) {
      return null;
    }
    if (!inMatch(this.game)) {
      return null;
    }
    const hit = this.players.hitTest(origin, dir, maxDist, (id) => Boolean(roster.get(id)?.alive));
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

  /** Where a player last said its body stood (ours: where it stands). */
  private bodyOf(id: string, game: StrikeforceGame): Point | undefined {
    return id === this.me ? game.player.pos : (this.players?.all.get(id)?.reported ?? undefined);
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
    this.rules ??= this.view ?? newMatch();
    const { rules } = this;
    const now = client.serverNow();
    syncRoster(rules, this.deployedIds(game));
    const events: MatchEvent[] = [];
    for (const p of this.players?.all.values() ?? []) {
      events.push(...applySelfReport(rules, p.id, p.hp, p.life, now));
    }
    events.push(
      ...applySelfReport(rules, this.me, game.player.health, this.placedLife, now),
      ...tick(rules, now),
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
      } else if (e.kind === "start") {
        // Every match starts on a full dock.
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
    if (was === "title" && inPlay(state) && online(game)) {
      // Deployed online: join the room; the first match read places us.
      this.placedLife = -1;
      darkenRelays(game);
      void this.connect();
    }
    this.stateListener?.(state, game);
  }

  /** Put our body where the match says it is, and keep the HUD on the match. */
  private followMatch(game: StrikeforceGame): void {
    const m = this.view;
    const me = m?.roster.get(this.me);
    if (!inMatch(game) || !m || !me) {
      return;
    }
    this.syncBody(game, me);
    this.announce(game, m);
    this.objective(game, m);
  }

  /**
   * Place the body whenever the host brings our fighter back (a new life: a
   * match start, a respawn), and go down when the host says so.
   */
  private syncBody(game: StrikeforceGame, me: Fighter): void {
    const { player } = game;
    if (me.alive && me.life !== this.placedLife) {
      this.place(game, me);
    }
    if (!me.alive && player.alive && me.life === this.placedLife) {
      // The host says we are down (a hit we missed).
      player.damage(9999);
    }
    player.enabled = true;
  }

  private place(game: StrikeforceGame, me: Fighter): void {
    const spawn = safestSpawn(this.spawns, this.enemies());
    if (spawn) {
      game.player.reset({ pos: spawn.pos.clone(), yaw: spawn.yaw });
      game.weapon.reset();
    }
    this.placedLife = me.life;
  }

  private announce(game: StrikeforceGame, m: MatchState): void {
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

  /** Kills and standing; no markers, no prompt. */
  private objective(game: StrikeforceGame, m: MatchState): void {
    const kills = m.roster.get(this.me)?.kills ?? 0;
    const place = standings(m).findIndex(([id]) => id === this.me);
    game.hud.setTally(`${kills} kills · ${place <= 0 ? "leading" : `#${place + 1}`}`);
    game.hud.setObjective(
      m.phase === "warmup" ? "Waiting for a rival" : `First to ${RULES.kills} kills`,
    );
    game.hud.setMarkers([]);
    game.hud.setPrompt(null);
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
      const v = nums(payload, 3);
      if (playing && v) {
        remoteShot(payload, game);
        // Firing gives you away on everyone's radar.
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
