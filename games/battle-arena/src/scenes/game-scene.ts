// Game scene — runs local (vs bots) or online (host-authoritative). The sim is
// identical in both; only authority + transport differ. Mirrors games/moba:
// guests send INTENT events and render snapshots; the host simulates and
// broadcasts under sharedState.snap, with stale-host takeover.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL, KILL_GOAL_FFA, SHOP_RADIUS, SIM_DT, SNAPSHOT_HZ } from "../data/config";
import { CHAMP_BY_ID, DEFAULT_CHAMP, valAt } from "../data/champions";
import { HALF, isInThrone, SPAWNS } from "../data/map";
import { terrainHeight } from "../data/terrain";
import { ALL_ABILITY_KEYS } from "../sim/types";
import type { AbilityKey, Unit, World } from "../sim/types";
import { requestCast, activateItem } from "../sim/abilities";
import { buyItem } from "../sim/home-base";
import { createWorld, ensureBots, setHeroInput, spawnHero, step, tryJump } from "../sim/world";
import { INTENT_EVENT, MULTIPLAYER_HOST, PARTY } from "../net/protocol";
import type { Intent } from "../net/protocol";
import { applySnapshot, emptyGuestWorld, encodeWorld, isSnapshot } from "../net/snapshot";
import type { Vec2 } from "../sim/math";
import { isJsonNumber, isJsonObject, isJsonString } from "../data/json";
import type { JsonValue } from "../data/json";
import type { Controls } from "../input/controls";
import type { TouchControls } from "../input/touch";
import type { ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import type { Audio } from "../render/audio";
import { Hud } from "../render/hud";
import { Hints } from "../render/hints";

const ONLINE_SEED = 0xba_da_55;
// camera fly-in length; solo holds the sim this long (NEVER online)
const INTRO_S = 2.4;
// mirror of the sim's cast-buffer window — deny-feedback only
const CAST_BUFFER_MS = 350;
// intensity driver runs at 4Hz
const MUSIC_SAMPLE_S = 0.25;
// intensity only drops after 4s of sustained calm
const MUSIC_DROP_HYST_S = 4;
// online intro banner
const JOINING_TEXT = `JOINING — FIRST TO ${KILL_GOAL_FFA} KILLS`;

export interface SceneOpts {
  champId: string;
  name: string;
  online: boolean;
  room: string;
}

const clamp1 = (n: number): number => (n < -1 ? -1 : Math.min(1, n));
const clampArena = (n: number): number => Math.min(HALF, Math.max(-HALF, n));
const num = (n: JsonValue | undefined): number => (isJsonNumber(n) ? n : 0);
const numArena = (n: JsonValue | undefined): number => clampArena(num(n));

const leaderUnit = (w: World): Unit | null => {
  if (w.leaderId === null) {
    return null;
  }
  for (const u of w.units.values()) {
    if (u.kind === "hero" && u.team === w.leaderId) {
      return u;
    }
  }
  return null;
};

interface MoveInput {
  mv: Vec2;
  attack: boolean;
}

/** 3 · 2 · 1 over the solo intro; 0 once the fight is on. */
const countdownAt = (t: number): number => {
  if (t < 0.8) {
    return 3;
  }
  if (t < 1.6) {
    return 2;
  }
  return t < INTRO_S ? 1 : 0;
};

export class GameScene {
  world: World;
  private net: MultiplayerClient | null = null;
  private worldView: WorldView;
  private environment: Environment;
  private fx: Fx;
  private hud: Hud;
  private acc = 0;
  private aimX = 0;
  private aimY = 1;
  // seed the heading from spawn facing once
  private aimInit = false;
  private champId: string;
  private name: string;
  private localId = "h-local";
  private statusEl: HTMLDivElement;
  private hints: Hints;
  // intro fly-in + countdown (solo: 3-2-1-FIGHT; online: camera sweep only)
  private introTime = 0;
  // change-gate for count()/fight() one-shots
  private lastCount = -1;
  // music intensity driver (4Hz sample, 4s drop hysteresis)
  private musicClock = 0;
  private musicAcc = 0;
  private musicIntensity: 0 | 1 | 2 | 3 = 0;
  private musicLowSince = -1;
  // touch integration (change-gated per-frame feeds)
  private boundChamp = "";
  private readonly touchCdLast = {
    DASH: -1,
    E: -1,
    JUMP: -1,
    Q: -1,
    R: -1,
    W: -1,
  } satisfies Record<AbilityKey, number>;

  // online state
  private picks: Record<string, { champId: string; name: string }> = {};
  private assign = new Map<string, number>();
  private joinResendAt = 0;
  private snapAcc = 0;
  private netFx: World["fx"] = [];
  private fxSeqOut = 0;
  private lastFxSeq = -1;
  // host-takeover
  private forcedHost = false;
  private tookOverFrom: string | null = null;
  private rateAt0 = 0;
  private rateGameTime0 = -1;
  private slowWindows = 0;

  private view: View;
  private controls: Controls;
  private touch: TouchControls | null;

  constructor(
    view: View,
    lib: ModelLibrary,
    controls: Controls,
    opts: SceneOpts,
    touch: TouchControls | null = null,
  ) {
    this.view = view;
    this.controls = controls;
    this.touch = touch;
    this.champId = opts.champId;
    this.name = opts.name;

    if (opts.online) {
      this.world = emptyGuestWorld();
      this.net = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        maxPlayers: ARENA_BOT_FILL,
        onEvent: (e, p, from) => this.onNetEvent(e, p, from),
        party: PARTY,
        room: opts.room,
      });
    } else {
      // soloMercy: hidden bot-damage softening for struggling humans — OFFLINE
      // ONLY (never set online; it must not shift the shared sim's balance)
      this.world = createWorld(0x1_23_4a_bc, { soloMercy: true });
      spawnHero(this.world, {
        champId: this.champId,
        id: this.localId,
        isBot: false,
        name: this.name,
        ownerId: "local",
        slot: 0,
        team: "local",
      });
      ensureBots(this.world);
    }

    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = this.localId;
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    // scenery is final — bake the static shadow map once
    view.refreshShadows();
    this.fx = new Fx(view.scene, view);
    // compile the FX programs before the first cast
    this.fx.warm(view.renderer, view.camera);
    this.fx.localId = this.localId;
    // ownerId flavor of the local identity ("local" offline, connId online —
    // refreshed per-frame in tickOnline once the connection knows itself)
    if (!opts.online) {
      this.fx.localOwnerId = "local";
    }
    this.worldView.fx = this.fx;
    this.hud = new Hud(view, this.fx, {
      buy: (id) => this.requestBuy(id),
      canShop: () => this.canShop(),
    });
    // contextual hint engine — DOM-free; the HUD renders via showHint("" hides)
    this.hints = new Hints(
      () => this.touch?.active ?? false,
      (t) => this.hud.showHint(t),
    );

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:800 22px ui-monospace,monospace;color:#9fd0ff;text-shadow:0 2px 6px #000;z-index:9;pointer-events:none";
    document.body.append(this.statusEl);

    // NB: the old fixed-center crosshair div lived here; superseded by the
    // HUD's #ba-reticle (hit-confirm ticks, fed by fx.localHits).

    // cinematic fly-in (both modes; only solo holds the sim)
    view.startIntro();
  }

  private get amHost(): boolean {
    return !this.net || (this.net.isHost ?? false) || this.forcedHost;
  }

  private localUnit(): Unit | null {
    return this.world.units.get(this.localId) ?? null;
  }

  // ── per-frame ──
  update(frameDt: number): void {
    // poll the physical pad before any reads
    this.controls.update(frameDt);
    // real-time clock for the fly-in/countdown
    this.introTime += frameDt;
    if (this.net) {
      this.tickOnline(frameDt);
    } else {
      this.tickLocal(frameDt);
    }

    // adaptive resolution (real, unscaled dt)
    this.view.samplePerf(frameDt);
    const me = this.localUnit();
    // FX drains events first (it may arm a hit-stop), then the visual layer runs
    // on the slowed render-dt while the SIM already stepped on the real frameDt.
    this.fx.update(this.world, frameDt);
    const rdt = frameDt * this.fx.scaleNow();
    this.worldView.sync(this.world, rdt);
    if (me) {
      this.statusEl.textContent = "";
      this.hud.update(this.world, me, this.controls.scoreHeld());
      // listener facing must match the CAMERA frame so stereo pan tracks the
      // screen — the camera chases the aim on every input source
      this.fx.audio.setListener(me.x, me.y, this.aimX, this.aimY);
      if (this.touch && me.champId !== this.boundChamp) {
        this.boundChamp = me.champId;
        // icon backgrounds + keycaps, once
        this.touch.bindChamp(me.champId);
      }
      this.feedTouchCooldowns(me);
    } else {
      this.statusEl.textContent =
        this.net && this.net.connectionStatus !== "connected"
          ? "Connecting…"
          : "Joining the arena…";
    }
    this.hints.update(this.world, me);
    this.driveIntro();
    this.driveMusic(frameDt, me);
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    // Every input source is FPS-framed: the camera chases behind the aim with
    // the crosshair dead center (touch turns the view via the right stick, so
    // both sticks stay camera-relative and never flip under the thumbs).
    this.view.follow(
      cx,
      cy,
      this.aimX,
      this.aimY,
      this.controls.aimPitch(),
      rdt,
      terrainHeight(cx, cy),
    );
    this.view.tickAura(this.world.gameTime);
    // proximity-driven decor (fountain rims)
    this.environment.setLocalPos(cx, cy);
    if (me) {
      this.environment.setHomeSlot(me.slot);
      // own fountain never warns
    }
    this.environment.update(this.world.gameTime);
    this.view.render();
  }

  // ── local mode ──
  private tickLocal(frameDt: number): void {
    // Intro fly-in (SOLO ONLY): the world literally waits for you — hold the
    // fixed-step accumulator and suppress input until the countdown ends.
    // NEVER hold online: guests join a live match (camera sweep only there).
    if (this.introTime < INTRO_S) {
      this.acc = 0;
      // seed the heading from spawn facing NOW so the fly-in lands on the same
      // chase pose readInput will use (no camera snap at FIGHT)
      const me = this.localUnit();
      if (me && !this.aimInit) {
        this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
        this.aimInit = true;
      }
      const yaw = this.controls.aimYaw();
      this.aimX = Math.sin(yaw);
      this.aimY = Math.cos(yaw);
      // discard buffered edges so a stray click/keypress during the fly-in
      // doesn't fire the moment the countdown hits FIGHT
      this.controls.consumeAbilities();
      this.controls.consumeItems();
      this.controls.consumeJump();
      this.controls.consumeDash();
      this.controls.consumeAttackEdge();
      this.controls.consumeBuy();
      if (this.touch) {
        this.touch.consumeAbilities();
        this.touch.consumeBuy();
        this.touch.consumeJump();
        this.touch.consumeDash();
        this.touch.consumeJumpAttack();
      }
      return;
    }
    const me = this.localUnit();
    if (me) {
      this.readInput(me, true, frameDt);
    }
    this.acc += frameDt;
    let n = 0;
    while (this.acc >= SIM_DT && n < 5) {
      step(this.world);
      this.acc -= SIM_DT;
      n += 1;
    }
  }

  /** Drive the HUD countdown + count/fight one-shots off the intro clock.
   *  hud.showIntro renders the text (change-gated; "" hides; "FIGHT!" pops). */
  private driveIntro(): void {
    const t = this.introTime;
    if (t > INTRO_S + 1.2) {
      return;
      // countdown + FIGHT flash fully done
    }
    if (this.net) {
      // online: the sim is live — no numerals, just the goal during the sweep
      this.hud.showIntro(t < 2 ? JOINING_TEXT : "");
      return;
    }
    const n = countdownAt(t);
    if (n > 0) {
      this.hud.showIntro(String(n));
    } else {
      this.hud.showIntro(t < INTRO_S + 0.5 ? "FIGHT!" : "");
    }
    if (n !== this.lastCount) {
      this.lastCount = n;
      if (n > 0) {
        this.fx.audio.count();
      } else {
        this.fx.audio.fight();
      }
    }
  }

  // ── music intensity driver (result-05 A5) ──
  private driveMusic(frameDt: number, me: Unit | null): void {
    this.musicClock += frameDt;
    this.musicAcc += frameDt;
    if (this.musicAcc < MUSIC_SAMPLE_S) {
      return;
    }
    this.musicAcc = 0;
    if (this.world.phase !== "playing" || !me) {
      return;
    }
    // null until the audio unlock gesture — don't track state the music system
    // never heard, or it would come up out of sync after unlock
    const { music } = this.fx.audio;
    if (!music) {
      return;
    }
    const desired = this.musicDesired(this.world, me);
    if (desired > this.musicIntensity) {
      // escalate immediately
      this.musicIntensity = desired;
      this.musicLowSince = -1;
      music.setIntensity(desired);
    } else if (desired < this.musicIntensity) {
      // de-escalate only after sustained calm (drop hysteresis)
      if (this.musicLowSince < 0) {
        this.musicLowSince = this.musicClock;
      } else if (this.musicClock - this.musicLowSince >= MUSIC_DROP_HYST_S) {
        this.musicIntensity = desired;
        this.musicLowSince = -1;
        music.setIntensity(desired);
      }
    } else {
      this.musicLowSince = -1;
    }
  }

  private musicDesired(w: World, me: Unit): 0 | 1 | 2 | 3 {
    // 3: endgame stakes or a contested throne
    if (w.suddenDeath || w.matchTime - w.gameTime < 60) {
      return 3;
    }
    if (isInThrone(me.x, me.y) && this.enemyHeroNear(me, 0, 0, 11)) {
      return 3;
    }
    // 2: you lead, or you're close to the leader
    if (w.leaderId !== null && w.leaderId === me.team) {
      return 2;
    }
    const leader = leaderUnit(w);
    if (leader && leader.alive) {
      const dx = leader.x - me.x;
      const dy = leader.y - me.y;
      if (dx * dx + dy * dy < 400) {
        return 2;
      }
    }
    // 1: enemies near or recent combat
    if (this.enemyHeroNear(me, me.x, me.y, 14)) {
      return 1;
    }
    if (w.now - me.lastHitAt < 3000 || w.now - me.lastAttackAt < 3000) {
      return 1;
    }
    return 0;
  }

  private enemyHeroNear(me: Unit, x: number, y: number, r: number): boolean {
    const r2 = r * r;
    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || u.team === me.team) {
        continue;
      }
      const dx = u.x - x;
      const dy = u.y - y;
      if (dx * dx + dy * dy < r2) {
        return true;
      }
    }
    return false;
  }

  /** Feed QWER cooldown sweeps to the touch buttons (int-percent change-gated). */
  private feedTouchCooldowns(me: Unit): void {
    const { touch } = this;
    if (!touch || !touch.active) {
      return;
    }
    const def = CHAMP_BY_ID[me.champId];
    if (!def) {
      return;
    }
    for (const key of ALL_ABILITY_KEYS) {
      const slot = me.abilities[key];
      let pct = 0;
      if (slot.rank < 1) {
        // locked reads as a full sweep (dimmed)
        pct = 1;
      } else {
        const left = Math.max(0, (slot.readyAt - this.world.now) / 1000);
        if (left > 0) {
          const total = valAt(def.abilities[key].cooldown, slot.rank);
          pct = total > 0 ? Math.min(1, left / total) : 0;
        }
      }
      const q = Math.round(pct * 100);
      if (q !== this.touchCdLast[key]) {
        this.touchCdLast[key] = q;
        touch.setCooldown(key, q / 100);
      }
    }
  }

  // ── online mode ──
  private tickOnline(frameDt: number): void {
    const { net } = this;
    if (!net) {
      return;
    }
    if (net.connectionStatus !== "connected" || !net.playerId) {
      return;
    }

    this.localId = `h-${net.playerId}`;
    this.worldView.localId = this.localId;
    this.fx.localId = this.localId;
    this.fx.localOwnerId = net.playerId;

    // announce our champ pick (and re-announce so a migrated host learns it)
    if (this.world.now - this.joinResendAt > 3000 || this.joinResendAt === 0) {
      net.sendEvent(INTENT_EVENT, {
        champId: this.champId,
        kind: "join",
        name: this.name,
      } satisfies Intent);
      this.joinResendAt = this.world.now;
    }

    this.driveHostTakeover(net);

    const me = this.localUnit();
    if (me) {
      this.readInput(me, this.amHost, frameDt);
    }

    if (this.amHost) {
      this.becomeHostIfNeeded();
      this.reconcileHeroes(net);
      this.acc += frameDt;
      let n = 0;
      while (this.acc >= SIM_DT && n < 5) {
        step(this.world);
        this.acc -= SIM_DT;
        n += 1;
      }
      if (this.world.fx.length) {
        this.netFx.push(...this.world.fx);
      }
      this.broadcast(frameDt);
    } else {
      this.applyHostBroadcast(net);
    }
  }

  /** Watch the host's broadcast for a stall; take over if it died. */
  private driveHostTakeover(net: MultiplayerClient): void {
    this.sampleHostLiveness(net);
    if (!net.isHost && !this.forcedHost && this.shouldTakeOverHost(net)) {
      this.forcedHost = true;
      this.tookOverFrom = net.hostId;
      // CONTINUE the snapshot-synced world (rngState/seq/scores carried) — only
      // seed fresh if we somehow have nothing. Never wipe a live match.
      this.assign.clear();
      if (this.world.units.size === 0) {
        this.world = createWorld(ONLINE_SEED);
      }
    }
    if (this.forcedHost && net.isHost) {
      this.forcedHost = false;
    } else if (
      this.forcedHost &&
      net.hostId &&
      net.hostId !== net.playerId &&
      net.hostId !== this.tookOverFrom
    ) {
      this.forcedHost = false;
    }
  }

  private applyHostBroadcast(net: MultiplayerClient): void {
    const { snap } = net.sharedState;
    if (isSnapshot(snap)) {
      applySnapshot(this.world, snap);
    }
    const { fxSeq } = net.sharedState;
    if (isJsonNumber(fxSeq) && fxSeq !== this.lastFxSeq) {
      this.lastFxSeq = fxSeq;
      const { fx } = net.sharedState;
      if (Array.isArray(fx)) {
        // SAFETY: sharedState.fx is written only by the host's broadcast
        // (this same build serializing this.netFx), so its entries are FX
        // events; they are render-only and never feed back into the sim.
        this.world.fx.push(...(fx as World["fx"]));
      }
    }
  }

  /** Compose forward/strafe into a world-space vector relative to the aim
   *  ((-aimY, aimX) is screen-right when looking along the aim). */
  private rotateToAim(fwd: number, strafe: number): Vec2 {
    return {
      x: this.aimX * fwd - this.aimY * strafe,
      y: this.aimY * fwd + this.aimX * strafe,
    };
  }

  /** Read controls → apply locally (host) or send as an intent (guest). */
  private readInput(me: Unit, host: boolean, dt: number): void {
    // MOUSE mode while a menu owns the cursor (shop, end screen); ACTION mode
    // (locked pointer) the rest of the match. Controls no-ops when unchanged.
    this.controls.setMouseMode(this.hud.isShopOpen || this.world.phase === "ended");
    if (!me.alive) {
      if (host) {
        setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      }
      return;
    }
    this.readAim(me, dt);
    const { mv, attack: attackHeld } = this.readMove();
    let attack = attackHeld;
    const castPoint: Vec2 = { x: me.x + this.aimX * 8, y: me.y + this.aimY * 8 };

    // JUMP ability: while AIRBORNE an LMB-edge casts the leaping strike and
    // suppresses that frame's basic (a grounded click stays a normal attack).
    // Touch fires it directly via its JUMP button — dispatch self-leaps if
    // grounded, so the ability works uniformly for touch/bots/guests. The LMB
    // edge is drained every frame so a grounded click never lingers into a hop.
    const airborne = this.world.now < me.jumpUntil;
    const lmbJump = this.controls.consumeAttackEdge() && airborne;
    const touchJump = this.touch?.consumeJumpAttack() ?? false;
    if (lmbJump || touchJump) {
      if (lmbJump) {
        attack = false;
        // resolve the ambiguous airborne LMB toward JUMP
      }
      this.dispatchCast(host, me, "JUMP", { x: this.aimX, y: this.aimY }, castPoint);
    }

    if (host) {
      setHeroInput(me, mv.x, mv.y, this.aimX, this.aimY, attack);
    } else {
      this.net?.sendEvent(INTENT_EVENT, {
        attack,
        ax: this.aimX,
        ay: this.aimY,
        kind: "input",
        mx: mv.x,
        my: mv.y,
      } satisfies Intent);
    }

    this.readAbilities(me, host, castPoint);
    this.readHop(me, host);
    this.readDash(me, host, mv, castPoint);
    this.readItems(me, host, castPoint);
    this.readBuy();
  }

  /** FPS-centered aim for EVERY input source: heading comes from mouse turn,
   *  pad stick, or the touch look stick; the crosshair is dead center. The
   *  character faces the crosshair; camera trails behind. */
  private readAim(me: Unit, dt: number): void {
    if (!this.aimInit) {
      this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
      this.aimInit = true;
    }
    if (this.touch?.active) {
      // the right stick TURNS the view (pad-rate mapping into yaw/pitch)
      // instead of aiming in screen space — so the camera tracks the aim
      const look = this.touch.lookVec();
      if (look) {
        this.controls.applyStickLook(look.x, look.y, dt);
      }
    }
    const yaw = this.controls.aimYaw();
    this.aimX = Math.sin(yaw);
    this.aimY = Math.cos(yaw);
  }

  private readMove(): MoveInput {
    if (this.touch?.active) {
      // stick axes are y-down; up = forward
      const m = this.touch.moveVec();
      // analog magnitude carries through
      return { attack: this.touch.attackDown(), mv: this.rotateToAim(-m.y, m.x) };
    }
    const { fwd, strafe } = this.controls.moveAxes();
    const mv = this.rotateToAim(fwd, strafe);
    const l = Math.hypot(mv.x, mv.y);
    if (l > 0) {
      mv.x /= l;
      mv.y /= l;
    }
    return { attack: this.controls.attackDown(), mv };
  }

  /** Host casts through the sim's input buffer; a guest sends the intent. */
  private dispatchCast(host: boolean, me: Unit, key: AbilityKey, dir: Vec2, point: Vec2): void {
    if (host) {
      requestCast(this.world, me, key, { dir, point });
    } else {
      this.net?.sendEvent(INTENT_EVENT, {
        ax: dir.x,
        ay: dir.y,
        key,
        kind: "cast",
        px: point.x,
        py: point.y,
      } satisfies Intent);
    }
  }

  private readAbilities(me: Unit, host: boolean, castPoint: Vec2): void {
    const keys = [...this.controls.consumeAbilities(), ...(this.touch?.consumeAbilities() ?? [])];
    for (const key of keys) {
      // deny feedback is a pre-check (locked / beyond the buffer window) — a
      // requestCast returning false may just mean "buffered", which is not a
      // deny. The cast/intent is ALWAYS issued; the host stays authoritative.
      if (this.wouldDeny(me, key)) {
        this.fx.audio.castDeny();
      }
      this.dispatchCast(host, me, key, { x: this.aimX, y: this.aimY }, castPoint);
    }
  }

  /** Space / touch HOP: evasive hop (drain both edges every frame). */
  private readHop(me: Unit, host: boolean): void {
    const kbJump = this.controls.consumeJump();
    const tJump = this.touch?.consumeJump() ?? false;
    if (kbJump || tJump) {
      if (host) {
        tryJump(this.world, me);
      } else {
        this.net?.sendEvent(INTENT_EVENT, { kind: "jump" } satisfies Intent);
      }
    }
  }

  /** Shift / touch DASH: cast the hero's DASH ability (mobility + i-frames).
   *  It goes in the MOVEMENT (arrow) direction — where you're steering — and
   *  only falls back to the aim direction when standing still. */
  private readDash(me: Unit, host: boolean, mv: Vec2, castPoint: Vec2): void {
    const dash = this.controls.consumeDash() || (this.touch?.consumeDash() ?? false);
    if (dash) {
      const dashDir = mv.x !== 0 || mv.y !== 0 ? mv : { x: this.aimX, y: this.aimY };
      this.dispatchCast(host, me, "DASH", dashDir, castPoint);
    }
  }

  /** Item actives: 5–0 keys + belt-chip taps (the only touch path to items). */
  private readItems(me: Unit, host: boolean, castPoint: Vec2): void {
    for (const slot of [...this.controls.consumeItems(), ...this.hud.consumeItemTaps()]) {
      if (host) {
        activateItem(this.world, me, slot, castPoint);
      } else {
        this.net?.sendEvent(INTENT_EVENT, {
          kind: "useItem",
          px: castPoint.x,
          py: castPoint.y,
          slot,
        } satisfies Intent);
      }
    }
  }

  private readBuy(): void {
    const buy = this.controls.consumeBuy() || (this.touch?.consumeBuy() ?? false);
    if (buy && (this.canShop() || this.hud.isShopOpen)) {
      this.hud.toggleShop();
      if (this.hud.isShopOpen) {
        this.hints.notifyShopOpened();
        // early-dismiss the shop hint
      }
    }
  }

  /** Locked, or on cooldown past the sim's buffer window → the press is a deny. */
  private wouldDeny(me: Unit, key: AbilityKey): boolean {
    const slot = me.abilities[key];
    return slot.rank < 1 || slot.readyAt - this.world.now > CAST_BUFFER_MS;
  }

  private requestBuy(itemId: string): void {
    const me = this.localUnit();
    if (!me) {
      return;
    }
    if (this.amHost) {
      buyItem(this.world, me, itemId);
    } else {
      this.net?.sendEvent(INTENT_EVENT, { itemId, kind: "buy" } satisfies Intent);
    }
  }

  // ── host: receive intents ──
  private onNetEvent(event: string, payload: JsonValue, from: string): void {
    if (event !== INTENT_EVENT) {
      return;
    }
    // Parse the wire intent field-by-field — a malformed/malicious client must
    // not inject NaN/Inf or spoofed shapes into the authoritative sim.
    if (!isJsonObject(payload)) {
      return;
    }
    const intent = payload;
    if (intent["kind"] === "join") {
      const { champId } = intent;
      const { name } = intent;
      if (isJsonString(champId) && isJsonString(name)) {
        this.picks[from] = { champId, name };
      }
      return;
    }
    if (!this.amHost) {
      return;
    }
    const u = this.world.units.get(`h-${from}`);
    if (!u || !u.alive) {
      return;
    }
    switch (intent["kind"]) {
      case "input": {
        setHeroInput(
          u,
          clamp1(num(intent["mx"])),
          clamp1(num(intent["my"])),
          clamp1(num(intent["ax"])),
          clamp1(num(intent["ay"])),
          intent["attack"] === true,
        );
        break;
      }
      case "cast": {
        // reject a bad/spoofed key before it reaches the sim; requestCast so
        // guests get the same host-side input buffer as locals
        const key = ALL_ABILITY_KEYS.find((k) => k === intent["key"]);
        if (!key) {
          break;
        }
        requestCast(this.world, u, key, {
          dir: { x: clamp1(num(intent["ax"])), y: clamp1(num(intent["ay"])) },
          point: { x: numArena(intent["px"]), y: numArena(intent["py"]) },
        });
        break;
      }
      case "buy": {
        const { itemId } = intent;
        if (isJsonString(itemId)) {
          buyItem(this.world, u, itemId);
        }
        break;
      }
      case "useItem": {
        activateItem(this.world, u, num(intent["slot"]), {
          x: numArena(intent["px"]),
          y: numArena(intent["py"]),
        });
        break;
      }
      case "jump": {
        tryJump(this.world, u);
        break;
      }
      default: {
        break;
      }
    }
  }

  // ── host: spawn/maintain hero set ──
  private becomeHostIfNeeded(): void {
    if (this.world.units.size === 0 && this.world.gameTime === 0) {
      this.world = createWorld(ONLINE_SEED);
    }
  }

  private reconcileHeroes(net: MultiplayerClient): void {
    const conns = Object.keys(net.players);
    // drop heroes for departed humans
    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || u.isBot) {
        continue;
      }
      if (!conns.includes(u.ownerId)) {
        this.world.units.delete(u.id);
        this.assign.delete(u.ownerId);
      }
    }
    // assign stable slots + spawn known picks
    for (const connId of conns) {
      let slot = this.assign.get(connId);
      if (slot === undefined) {
        slot = this.freeSlot();
        this.assign.set(connId, slot);
      }
      const id = `h-${connId}`;
      if (!this.world.units.has(id)) {
        const pick = this.picks[connId];
        if (pick) {
          spawnHero(this.world, {
            champId: pick.champId,
            id,
            isBot: false,
            name: pick.name || "Player",
            ownerId: connId,
            slot,
            team: connId,
          });
        }
      }
    }
    ensureBots(this.world);
  }

  private freeSlot(): number {
    const used = new Set<number>([
      ...this.assign.values(),
      ...[...this.world.units.values()].filter((u) => u.kind === "hero").map((u) => u.slot),
    ]);
    for (let s = 0; s < SPAWNS.length; s += 1) {
      if (!used.has(s)) {
        return s;
      }
    }
    return 0;
  }

  private broadcast(dt: number): void {
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) {
      return;
    }
    this.snapAcc = 0;
    this.fxSeqOut += 1;
    this.net?.updateSharedState({
      fx: this.netFx,
      fxSeq: this.fxSeqOut,
      snap: encodeWorld(this.world),
    });
    this.netFx = [];
  }

  // ── host-takeover (mirrors moba) ──
  private sampleHostLiveness(net: MultiplayerClient): void {
    const { snap } = net.sharedState;
    if (!isSnapshot(snap)) {
      return;
    }
    // a finished match legitimately freezes gameTime — treat it as alive, don't
    // mistake the frozen clock for a dead host and trigger a takeover.
    if (snap.phase !== "playing") {
      this.slowWindows = 0;
      this.rateAt0 = 0;
      return;
    }
    const gt = snap.gameTime;
    const now = performance.now();
    if (this.rateAt0 === 0) {
      this.rateAt0 = now;
      this.rateGameTime0 = gt;
      return;
    }
    if (now - this.rateAt0 >= 2000) {
      const rate = (gt - this.rateGameTime0) / ((now - this.rateAt0) / 1000);
      this.slowWindows = rate < 0.5 ? this.slowWindows + 1 : 0;
      this.rateAt0 = now;
      this.rateGameTime0 = gt;
    }
  }

  private shouldTakeOverHost(net: MultiplayerClient): boolean {
    // take over only on a genuine stall (host crawling/frozen mid-match)
    if (this.slowWindows < 2) {
      return false;
    }
    const me = net.playerId;
    if (!me) {
      return false;
    }
    const others = Object.keys(net.players).filter((id) => id !== net.hostId);
    if (others.length === 0) {
      return true;
    }
    others.sort();
    return me === others[0];
  }

  private canShop(): boolean {
    const me = this.localUnit();
    if (!me || !me.alive) {
      return false;
    }
    const sp = SPAWNS[me.slot % SPAWNS.length];
    if (!sp) {
      return false;
    }
    return (me.x - sp.x) ** 2 + (me.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
  }

  /** The match's audio bus — main.ts hands its mute flag to the touch cluster. */
  get audio(): Audio {
    return this.fx.audio;
  }

  /** Wrapper-requested pause/resume (see main.ts's setPauseHandlers wiring) —
   *  offline only, the sim itself is frozen by simply not calling update(). */
  pauseAudio(): void {
    this.fx.audio.suspend();
  }

  resumeAudio(): void {
    this.fx.audio.resume();
  }

  dispose(): void {
    this.net?.destroy();
    this.statusEl.remove();
    this.hud.dispose();
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }
}

/** Champion for quick-start boots: ?champ → localStorage["ba-champ"] → default.
 *  Both sources are validated against the roster so a stale/typo'd id can never
 *  crash the boot. The menu's START writes the localStorage key. */
export const chosenChamp = (): string => {
  const fromUrl = new URLSearchParams(location.search).get("champ");
  if (fromUrl && CHAMP_BY_ID[fromUrl]) {
    return fromUrl;
  }
  const stored = localStorage.getItem("ba-champ");
  if (stored && CHAMP_BY_ID[stored]) {
    return stored;
  }
  return DEFAULT_CHAMP;
};

/** Player name for quick-start boots: ?name → localStorage["ba-name"] → "Player". */
export const chosenName = (): string => {
  const fromUrl = new URLSearchParams(location.search).get("name")?.trim();
  if (fromUrl) {
    return fromUrl.slice(0, 14);
  }
  const stored = localStorage.getItem("ba-name")?.trim();
  return stored ? stored.slice(0, 14) : "Player";
};
