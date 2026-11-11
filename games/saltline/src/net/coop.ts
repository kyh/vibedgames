// Co-op: the `G.net` hooks saltline-core.js calls, and everything behind them.
//
// Roles. Solo (offline, or still connecting) is the original single-player
// game. The room's host runs that same game — machines, relays, waves,
// barrels — and publishes it; the machines hunt every squad member through
// stand-ins (squad.ts). A guest runs only its own body and weapon: the machines
// are puppets of the host's (puppets.ts), its hits, relay cuts and barrel shots
// are requests to the host, and the host's hits on it arrive as `hurt`.
//
// Each client applies area damage (explosions) to its own body; the host
// applies it to the machines. A host whose squad is still out respawns into the
// run on retry instead of resetting it, and a host that leaves hands the run to
// whoever the server elects: its puppets become real machines where they stand.
import { FixedRate } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type {
  EnemyBody,
  EnemyCue,
  EnemyTarget,
  GameState,
  NetHooks,
  RunState,
  SaltlineGame,
  WeaponFire,
} from "../core/types";
import { CUE, EV, PHASE, WORLD_HZ, WORLD_KEY, BODY_HZ, q3 } from "./protocol";
import { Puppets } from "./puppets";
import { Squad } from "./squad";
import type { Member } from "./squad";
import { SquadHud } from "./squad-hud";
import { isNum, isRecord, isStr, numOr, nums, strs, vecAt, vecWire } from "./wire";

type Role = "solo" | "host" | "guest";

export interface CoopProbe {
  role: Role;
  members: number;
  puppets: number;
  run: number | null;
}

const PHASE_OF = {
  complete: PHASE.extracted,
  dead: PHASE.down,
  intro: PHASE.deployed,
  paused: PHASE.deployed,
  playing: PHASE.deployed,
  title: PHASE.menu,
} satisfies Record<GameState, number>;

/** A guest re-asks the host for a relay it holds finished this often. */
const CUT_RETRY_MS = 400;
/** A machine keeps its quarry until another squad member is this much closer. */
const RETARGET_RATIO = 0.75;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const readRun = (w: JsonRecord): RunState => ({
  cleared: numOr(w.cleared, 0),
  cut: strs(w.cut),
  diff: isStr(w.diff) ? w.diff : "hard",
  kills: numOr(w.kills, 0),
  live: w.live === true,
  mode: isStr(w.mode) ? w.mode : "mission",
  run: numOr(w.run, 0),
  score: numOr(w.score, 0),
  wave: numOr(w.wave, 0),
  waveOn: w.waveOn === true,
});

const publishWorld = (client: MultiplayerClient, game: SaltlineGame): void => {
  const run = game.game.netWorld();
  const en: JsonRecord = {};
  for (const body of game.enemies.list) {
    if (body.alive && body.active) {
      en[String(body.id)] = body._net().map(q3);
    }
  }
  client.updateSharedState({
    [WORLD_KEY]: {
      bar: game.explosives.aliveMask(),
      cleared: run.cleared,
      cut: run.cut,
      diff: run.diff,
      en,
      kills: run.kills,
      live: run.live,
      mode: run.mode,
      run: run.run,
      score: run.score,
      t: Math.round(client.serverNow()),
      wave: run.wave,
      waveOn: run.waveOn,
    },
  });
};

const publishBody = (client: MultiplayerClient, game: SaltlineGame): void => {
  const p = game.player;
  client.updateMyState({
    a: p.alive ? 1 : 0,
    c: p.crouching ? 1 : 0,
    hp: Math.round(p.health),
    ph: PHASE_OF[game.game.state],
    pitch: q3(p.pitch),
    t: Math.round(client.serverNow()),
    x: q3(p.pos.x),
    y: q3(p.pos.y),
    yaw: q3(p.yaw),
    z: q3(p.pos.z),
  });
};

const applyHit = (
  payload: JsonValue,
  from: string,
  game: SaltlineGame,
  client: MultiplayerClient,
): void => {
  if (!isRecord(payload) || !isStr(payload.i) || !isNum(payload.d)) {
    return;
  }
  const netId = payload.i;
  const body = game.enemies.list.find((e) => e.alive && String(e.id) === netId);
  if (!body) {
    return;
  }
  const at = nums(payload.at, 3);
  const dir = nums(payload.dir, 3);
  const killed = body.damage(
    Math.min(payload.d, 400),
    at ? vecAt(at, 0, new Vector3()) : body.pos.clone(),
    dir ? vecAt(dir, 0, new Vector3()) : null,
    isStr(payload.p) ? payload.p : "body",
  );
  if (killed) {
    client.sendEvent(EV.kill, netId, { to: from });
  }
};

const onHostEvent = (
  event: string,
  payload: JsonValue,
  from: string,
  game: SaltlineGame,
  client: MultiplayerClient,
): void => {
  if (event === EV.hit) {
    applyHit(payload, from, game, client);
  } else if (event === EV.cut && isStr(payload)) {
    game.game.netCut(payload);
  } else if (event === EV.barrel) {
    const v = nums(payload, 8);
    if (v) {
      game.explosives.netHit(v[0] ?? -1, v[1] ?? 0, v.slice(2, 5), v.slice(5, 8));
    }
  }
};

export class Coop implements NetHooks {
  private client: MultiplayerClient | null = null;
  private game: SaltlineGame | null = null;
  private squad: Squad | null = null;
  private puppets: Puppets | null = null;
  private readonly hud = new SquadHud();
  private role: Role = "solo";
  private hostId: string | null = null;
  private lastWorld: JsonValue | undefined = undefined;
  private lastRun: number | null = null;
  private mustRestart = false;
  private quiet = true;
  private mode: string | null = null;
  private cues: number[][] = [];
  private readonly cutAsked = new Map<string, number>();
  private readonly quarry = new Map<EnemyBody, EnemyTarget>();
  private seenState: GameState | null = null;
  private stateListener: ((state: GameState, game: SaltlineGame) => void) | null = null;
  private readonly worldRate = new FixedRate(WORLD_HZ);
  private readonly bodyRate = new FixedRate(BODY_HZ);
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  get coop(): boolean {
    if (this.role === "guest") {
      return true;
    }
    return this.role === "host" && (this.squad?.members.size ?? 0) > 0;
  }

  /** Players in this room, us included. */
  get squadSize(): number {
    return (this.squad?.members.size ?? 0) + 1;
  }

  /** For the two-client harness: what this client believes about the room. */
  probe(): CoopProbe {
    return {
      members: this.squad?.members.size ?? 0,
      puppets: this.puppets?.size ?? 0,
      role: this.role,
      run: this.lastRun,
    };
  }

  get guest(): boolean {
    return this.role === "guest";
  }

  get hostMode(): string | null {
    return this.mode;
  }

  /** The room arrived (or went offline): start speaking. */
  connect(client: MultiplayerClient): void {
    this.client = client;
    client.onEvent = (event, payload, from) => this.onEvent(event, payload, from);
  }

  /**
   * Hear the game's flow change (title → intro → playing → …), once per change,
   * starting with its state when it attaches. Register before bootSaltline.
   */
  watchState(listener: (state: GameState, game: SaltlineGame) => void): void {
    this.stateListener = listener;
  }

  attach(game: SaltlineGame): void {
    this.game = game;
    // Report the game now, during boot, not on the first frame: bootSaltline
    // resolves as soon as the loop is scheduled, before any frame runs.
    this.seenState = game.game.state;
    this.stateListener?.(game.game.state, game);
    this.puppets = new Puppets(game);
    this.squad = new Squad(game, {
      down: (m) => this.feed(m, "is down"),
      hurt: (m, amount, from) => this.hurt(m, amount, from),
      joined: (m) => this.feed(m, "joined the squad"),
      left: (m) => this.feed(m, "left"),
    });
    this.hud.mount();
    this.wrapEnemies(game);
    game.events.on("weapon:fire", (shot) => this.sendShot(shot));
    game.events.on("run:reset", () => {
      this.quiet = true;
      this.puppets?.clear(false);
      this.quarry.clear();
    });
    for (const name of ["enemy:fire", "enemy:telegraph", "enemy:melee", "enemy:alert"] as const) {
      game.events.on(name, (cue) => this.queueCue(name, cue));
    }
  }

  frame(dt: number, simulated: boolean): void {
    const { client, game, squad } = this;
    if (game && game.game.state !== this.seenState) {
      this.seenState = game.game.state;
      this.stateListener?.(game.game.state, game);
    }
    if (!client || !game || !squad) {
      return;
    }
    this.syncRole(client, game);
    squad.update(this.role === "solo" ? {} : client.players, client.playerId ?? "", dt);
    const { state } = game.game;
    this.keepWorldMoving(client, game, dt, simulated);
    const ms = dt * 1000;
    if (this.bodyRate.due(ms) && this.role !== "solo") {
      publishBody(client, game);
    }
    if (this.worldRate.due(ms) && this.role === "host" && this.coop) {
      publishWorld(client, game);
      this.flushCues(client);
    }
    this.hud.update({
      members: [...squad.members.values()],
      role: this.role,
      room: client.room,
      status: client.connectionStatus,
      title: state === "title",
    });
  }

  /**
   * The loop updates the world only while this player is in play. A guest's
   * dock keeps moving behind its menus; a host's whole run does, for the squad.
   */
  private keepWorldMoving(
    client: MultiplayerClient,
    game: SaltlineGame,
    dt: number,
    simulated: boolean,
  ): void {
    const { state } = game.game;
    if (this.role === "guest") {
      this.readWorld(client, game);
      if (!simulated) {
        game.enemies.update(dt);
      }
      return;
    }
    if (this.role !== "host" || !this.coop || state === "title") {
      return;
    }
    if (state === "paused" || state === "dead" || state === "complete") {
      game.game.worldTick(dt);
    }
    if (!simulated) {
      game.enemies.update(dt);
      game.explosives.update(dt);
    }
  }

  targets(): EnemyTarget[] {
    const { game, squad } = this;
    if (!game || this.role === "guest") {
      return [];
    }
    return [game.player, ...(squad?.targets() ?? [])];
  }

  keepWorld(): boolean {
    return this.role === "host" && (this.squad?.anyInRun() ?? false);
  }

  worldEvent(_kind: "warn", text: string): void {
    const { client } = this;
    if (client && this.role === "host" && this.coop) {
      client.sendEvent(EV.warn, text, { except: client.playerId ?? undefined });
    }
  }

  requestCut(relayId: string): void {
    const now = performance.now();
    if (now - (this.cutAsked.get(relayId) ?? -1e9) < CUT_RETRY_MS) {
      return;
    }
    this.cutAsked.set(relayId, now);
    this.client?.sendToHost(EV.cut, relayId);
  }

  barrelHit(index: number, damage: number, point: Vector3 | null, dir: Vector3 | null): void {
    if (index < 0) {
      return;
    }
    this.client?.sendToHost(EV.barrel, [index, q3(damage), ...vecWire(point), ...vecWire(dir)]);
  }

  // ---- roles ---------------------------------------------------------------

  private syncRole(client: MultiplayerClient, game: SaltlineGame): void {
    const status = client.connectionStatus;
    const online = status === "connected" || status === "reconnecting";
    let next: Role = "solo";
    if (online) {
      next = client.isHost ? "host" : "guest";
    }
    if (next === "guest" && client.hostId !== this.hostId && this.role === "guest") {
      // The host changed and it is not us: its machines carry new ids.
      this.puppets?.clear(true);
      this.lastRun = null;
      this.lastWorld = undefined;
    }
    this.hostId = client.hostId;
    if (next === this.role) {
      return;
    }
    const prev = this.role;
    this.role = next;
    if (next === "guest") {
      // Whatever ran here before is replaced by the host's world.
      this.puppets?.clear(false);
      game.enemies.clear();
      this.lastRun = null;
      this.lastWorld = undefined;
      this.mustRestart = true;
      this.quiet = true;
    } else if (prev === "guest") {
      this.puppets?.promote();
      this.mode = null;
      if (game.game.state !== "title") {
        game.hud.message("You lead the squad now", 3);
      }
    }
  }

  // ---- host ----------------------------------------------------------------

  private wrapEnemies(game: SaltlineGame): void {
    const { enemies } = game;
    const update = enemies.update.bind(enemies);
    enemies.update = (dt) => {
      const { puppets } = this;
      if (this.role === "guest" && puppets) {
        enemies.puppet(dt, (k) => puppets.step(k));
      } else {
        update(dt);
      }
    };
    for (const body of [...enemies.debug.gulls, ...enemies.debug.hounds]) {
      const brain = body._update.bind(body);
      const damage = body.damage.bind(body);
      body._update = (dt) => {
        if (!this.coop || this.role !== "host" || !body.alive) {
          brain(dt);
          return;
        }
        // The brain hunts whoever is G.player: hand it this machine's quarry.
        const local = game.player;
        Reflect.set(game, "player", this.quarryOf(body, game));
        try {
          brain(dt);
        } finally {
          Reflect.set(game, "player", local);
        }
      };
      body.damage = (amount, point, dir, part) =>
        this.role === "guest"
          ? this.askHit(body, amount, point, dir, part)
          : damage(amount, point, dir, part);
    }
  }

  private quarryOf(body: EnemyBody, game: SaltlineGame): EnemyTarget {
    const current = this.quarry.get(body);
    let best: EnemyTarget = game.player;
    let bestD = Infinity;
    let currentD = Infinity;
    for (const target of this.targets()) {
      if (!target.alive) {
        continue;
      }
      const d = target.pos.distanceTo(body.pos);
      if (target === current) {
        currentD = d;
      }
      if (d < bestD) {
        bestD = d;
        best = target;
      }
    }
    const pick =
      current && currentD < Infinity && bestD > currentD * RETARGET_RATIO ? current : best;
    this.quarry.set(body, pick);
    return pick;
  }

  private queueCue(
    name: "enemy:fire" | "enemy:telegraph" | "enemy:melee" | "enemy:alert",
    cue: EnemyCue,
  ): void {
    if (this.role !== "host" || !this.coop || !cue.enemy) {
      return;
    }
    const { id } = cue.enemy;
    if (name === "enemy:fire") {
      const kind = cue.enemy.type === "hound" ? 1 : 0;
      this.cues.push([CUE.fire, id, ...vecWire(cue.pos), ...vecWire(cue.dir), kind]);
    } else if (name === "enemy:telegraph") {
      this.cues.push([CUE.telegraph, id, q3(cue.time ?? 0.5), cue.melee ? 1 : 0]);
    } else if (name === "enemy:melee") {
      this.cues.push([CUE.melee, id]);
    } else {
      this.cues.push([CUE.alert, id]);
    }
  }

  private flushCues(client: MultiplayerClient): void {
    if (this.cues.length === 0) {
      return;
    }
    client.sendEvent(EV.cues, this.cues, { except: client.playerId ?? undefined });
    this.cues = [];
  }

  private hurt(member: Member, amount: number, from: Vector3 | undefined): void {
    this.client?.sendEvent(EV.hurt, [q3(amount), ...vecWire(from)], { to: member.id });
  }

  // ---- guest ---------------------------------------------------------------

  private readWorld(client: MultiplayerClient, game: SaltlineGame): void {
    const raw = client.sharedState[WORLD_KEY];
    if (raw === this.lastWorld || !isRecord(raw)) {
      return;
    }
    this.lastWorld = raw;
    const run = readRun(raw);
    this.mode = run.mode;
    if (run.run !== this.lastRun) {
      const restart = this.lastRun !== null || this.mustRestart;
      this.lastRun = run.run;
      this.mustRestart = false;
      if (restart && run.live && game.game.state !== "title") {
        game.game.netRestart();
      }
    }
    if (isRecord(raw.en) && isNum(raw.t)) {
      this.puppets?.apply(raw.t, raw.en, run.live);
    }
    game.game.netSync(run, this.quiet);
    this.quiet = false;
    if (isStr(raw.bar)) {
      game.explosives.syncMask(raw.bar);
    }
  }

  private askHit(
    body: EnemyBody,
    amount: number,
    point: Vector3 | undefined,
    dir: Vector3 | null | undefined,
    part: string | undefined,
  ): boolean {
    const netId = this.puppets?.netIdOf(body);
    if (!netId || !body.alive || !this.game) {
      return false;
    }
    this.client?.sendToHost(EV.hit, {
      at: vecWire(point),
      d: q3(amount),
      dir: vecWire(dir),
      i: netId,
      p: part ?? "body",
    });
    // Feedback now; the kill is the host's to confirm.
    this.game.events.emit("enemy:hit", { enemy: body, part: part ?? "body", point });
    return false;
  }

  private replayCue(cue: readonly number[], game: SaltlineGame): void {
    const body = this.puppets?.byId(String(cue[1]));
    if (!body) {
      return;
    }
    if (cue[0] === CUE.fire) {
      const pos = vecAt(cue, 2, new Vector3());
      const dir = vecAt(cue, 5, new Vector3()).normalize();
      const type = cue[8] === 1 ? "hound" : "gull";
      if (type === "gull") {
        game.enemies.netBolt(pos, dir);
        game.fx.muzzleFlash(pos, dir, { scale: 0.55 });
      } else {
        const hit = game.physics.raycast(pos, dir, 120);
        const end = this.a.copy(pos).addScaledVector(dir, hit ? hit.dist : 90);
        game.fx.tracer(pos, end, { color: 0xff_c0_70, speed: 260 });
        game.fx.muzzleFlash(pos, dir, { scale: 0.9 });
      }
      game.events.emit("enemy:fire", { dir, enemy: body, pos, type });
    } else if (cue[0] === CUE.telegraph) {
      game.events.emit("enemy:telegraph", {
        enemy: body,
        melee: cue[3] === 1,
        pos: body.pos,
        time: cue[2] ?? 0.5,
        type: body.type,
      });
    } else if (cue[0] === CUE.melee) {
      game.events.emit("enemy:melee", { enemy: body, pos: body.pos });
    } else {
      game.events.emit("enemy:alert", { enemy: body });
    }
  }

  // ---- everyone ------------------------------------------------------------

  private sendShot(shot: WeaponFire): void {
    const { client } = this;
    if (!client || this.role === "solo" || !shot.muzzle || !shot.end) {
      return;
    }
    client.sendEvent(
      EV.shot,
      [...vecWire(shot.muzzle), ...vecWire(shot.end), shot.weapon === "pistol" ? 1 : 0],
      { except: client.playerId ?? undefined },
    );
  }

  private onEvent(event: string, payload: JsonValue, from: string): void {
    const { game, client } = this;
    if (!game || !client || from === client.playerId) {
      return;
    }
    if (event === EV.shot) {
      this.remoteShot(payload, game, this.role === "host");
    } else if (this.role === "host") {
      onHostEvent(event, payload, from, game, client);
    } else if (this.role === "guest") {
      this.onGuestEvent(event, payload, game);
    }
  }

  private onGuestEvent(event: string, payload: JsonValue, game: SaltlineGame): void {
    if (event === EV.hurt) {
      const v = nums(payload, 4);
      if (v) {
        game.player.damage(v[0] ?? 0, vecAt(v, 1, new Vector3()));
      }
    } else if (event === EV.kill) {
      game.combat.stats.kills += 1;
      game.hud.hitmarker("kill");
    } else if (event === EV.cues && Array.isArray(payload)) {
      for (const raw of payload) {
        const cue = nums(raw, 2);
        if (cue) {
          this.replayCue(cue, game);
        }
      }
    } else if (event === EV.warn && isStr(payload)) {
      game.hud.warn(payload, 3.6);
    }
  }

  private remoteShot(payload: JsonValue, game: SaltlineGame, host: boolean): void {
    const v = nums(payload, 7);
    if (!v) {
      return;
    }
    const muzzle = vecAt(v, 0, this.a);
    const end = vecAt(v, 3, this.b);
    const dir = new Vector3().subVectors(end, muzzle).normalize();
    game.fx.tracer(muzzle, end);
    game.fx.muzzleFlash(muzzle, dir, { scale: 0.8 });
    game.audio.play?.(v[6] === 1 ? "pistol_shot" : "rifle_shot", {
      gain: 0.55,
      jitter: 0.03,
      pos: muzzle.clone(),
    });
    // A squad member's gunfire is as loud to the machines as ours.
    if (host) {
      game.enemies.alert(muzzle.clone(), game.enemies.TUNE.hearRadius);
    }
  }

  private feed(member: Member, what: string): void {
    this.game?.hud.feed(`<b>${escapeHtml(member.callsign)}</b> ${escapeHtml(what)}`);
  }
}
