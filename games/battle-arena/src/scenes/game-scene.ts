// Game scene — runs local (vs bots) or online (host-authoritative). The sim is
// identical in both; only authority + transport differ. Mirrors games/moba:
// guests send INTENT events and render snapshots; the host simulates and
// broadcasts under sharedState.snap, with stale-host takeover.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL, KILL_GOAL_FFA, SHOP_RADIUS, SIM_DT } from "../data/config";
import { CHAMP_BY_ID, DEFAULT_CHAMP, valAt } from "../data/champions";
import { HALF, isInThrone, SPAWNS } from "../data/map";
import { terrainHeight } from "../data/terrain";
import { ABILITY_KEYS, type AbilityKey, type Unit, type World } from "../sim/types";
import { requestCast, useItemActive } from "../sim/abilities";
import { buyItem, createWorld, ensureBots, requestDodge, setHeroInput, spawnHero, step, tryJump } from "../sim/world";
import { INTENT_EVENT, MULTIPLAYER_HOST, PARTY, type Intent } from "../net/protocol";
import { applySnapshot, emptyGuestWorld, encodeWorld, isSnapshot } from "../net/snapshot";
import { SNAPSHOT_HZ } from "../data/config";
import { Controls } from "../input/controls";
import { TouchControls } from "../input/touch";
import { ModelLibrary } from "../render/models";
import { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import { Hud } from "../render/hud";
import { Hints } from "../render/hints";

const ONLINE_SEED = 0xbada55;
const INTRO_S = 2.4; // camera fly-in length; solo holds the sim this long (NEVER online)
const CAST_BUFFER_MS = 350; // mirror of the sim's cast-buffer window — deny-feedback only
const MUSIC_SAMPLE_S = 0.25; // intensity driver runs at 4Hz
const MUSIC_DROP_HYST_S = 4; // intensity only drops after 4s of sustained calm
const JOINING_TEXT = `JOINING — FIRST TO ${KILL_GOAL_FFA} KILLS`; // online intro banner

export type SceneOpts = {
  champId: string;
  name: string;
  online: boolean;
  room: string;
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
  private aimInit = false; // seed the heading from spawn facing once
  private champId: string;
  private name: string;
  private localId = "h-local";
  private statusEl: HTMLDivElement;
  private hints: Hints;
  // intro fly-in + countdown (solo: 3-2-1-FIGHT; online: camera sweep only)
  private introTime = 0;
  private lastCount = -1; // change-gate for count()/fight() one-shots
  // music intensity driver (4Hz sample, 4s drop hysteresis)
  private musicClock = 0;
  private musicAcc = 0;
  private musicIntensity: 0 | 1 | 2 | 3 = 0;
  private musicLowSince = -1;
  // touch integration (change-gated per-frame feeds)
  private boundChamp = "";
  private readonly touchCdLast: Record<AbilityKey, number> = { Q: -1, W: -1, E: -1, R: -1 };

  // online state
  private picks: Record<string, { champId: string; name: string }> = {};
  private assign: Record<string, number> = {};
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

  constructor(
    private view: View,
    lib: ModelLibrary,
    private controls: Controls,
    opts: SceneOpts,
    private touch: TouchControls | null = null,
  ) {
    this.champId = opts.champId;
    this.name = opts.name;

    if (opts.online) {
      this.world = emptyGuestWorld();
      this.net = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        party: PARTY,
        room: opts.room,
        maxPlayers: ARENA_BOT_FILL,
        onEvent: (e, p, from) => this.onNetEvent(e, p, from),
      });
    } else {
      // soloMercy: hidden bot-damage softening for struggling humans — OFFLINE
      // ONLY (never set online; it must not shift the shared sim's balance)
      this.world = createWorld(0x1234abc, { soloMercy: true });
      spawnHero(this.world, {
        id: this.localId,
        ownerId: "local",
        team: "local",
        champId: this.champId,
        name: this.name,
        isBot: false,
        slot: 0,
      });
      ensureBots(this.world);
    }

    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = this.localId;
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    view.refreshShadows(); // scenery is final — bake the static shadow map once
    this.fx = new Fx(view.scene, view);
    this.fx.localId = this.localId;
    // ownerId flavor of the local identity ("local" offline, connId online —
    // refreshed per-frame in tickOnline once the connection knows itself)
    if (!opts.online) this.fx.localOwnerId = "local";
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
    document.body.appendChild(this.statusEl);

    // NB: the old fixed-center crosshair div lived here; superseded by the
    // HUD's #ba-reticle (hit-confirm ticks, fed by fx.localHits).

    view.startIntro(); // cinematic fly-in (both modes; only solo holds the sim)
  }

  private get amHost(): boolean {
    return !this.net || (this.net.isHost ?? false) || this.forcedHost;
  }

  private localUnit(): Unit | null {
    return this.world.units.get(this.localId) ?? null;
  }

  // ── per-frame ──
  update(frameDt: number): void {
    this.introTime += frameDt; // real-time clock for the fly-in/countdown
    if (this.net) this.tickOnline(frameDt);
    else this.tickLocal(frameDt);

    this.view.samplePerf(frameDt); // adaptive resolution (real, unscaled dt)
    const me = this.localUnit();
    // FX drains events first (it may arm a hit-stop), then the visual layer runs
    // on the slowed render-dt while the SIM already stepped on the real frameDt.
    this.fx.update(this.world, frameDt);
    const rdt = frameDt * this.fx.scaleNow();
    this.worldView.sync(this.world, rdt);
    if (me) {
      this.statusEl.textContent = "";
      this.hud.update(this.world, me, this.controls.scoreHeld());
      this.fx.audio.setListener(me.x, me.y, this.aimX, this.aimY);
      if (this.touch && me.champId !== this.boundChamp) {
        this.boundChamp = me.champId;
        this.touch.bindChamp(me.champId); // icon backgrounds + keycaps, once
      }
      this.feedTouchCooldowns(me);
    } else {
      this.statusEl.textContent =
        this.net && this.net.connectionStatus !== "connected" ? "Connecting…" : "Joining the arena…";
    }
    this.hints.update(this.world, me);
    this.driveIntro();
    this.driveMusic(frameDt, me);
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    const pitch = this.touch?.active ? 0 : this.controls.aimPitch();
    this.view.follow(cx, cy, this.aimX, this.aimY, pitch, rdt, terrainHeight(cx, cy));
    this.view.tickAura(this.world.gameTime);
    this.environment.setLocalPos(cx, cy); // proximity-driven decor (fountain rims)
    if (me) this.environment.setHomeSlot(me.slot); // own fountain never warns
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
      this.controls.consumeDodge();
      this.controls.consumeBuy();
      if (this.touch) {
        this.touch.consumeAbilities();
        this.touch.consumeBuy();
        this.touch.consumeJump();
        this.touch.consumeDodge();
      }
      return;
    }
    const me = this.localUnit();
    if (me) this.readInput(me, true);
    this.acc += frameDt;
    let n = 0;
    while (this.acc >= SIM_DT && n < 5) {
      step(this.world);
      this.acc -= SIM_DT;
      n++;
    }
  }

  /** Drive the HUD countdown + count/fight one-shots off the intro clock.
   *  hud.showIntro renders the text (change-gated; "" hides; "FIGHT!" pops). */
  private driveIntro(): void {
    const t = this.introTime;
    if (t > INTRO_S + 1.2) return; // countdown + FIGHT flash fully done
    if (this.net) {
      // online: the sim is live — no numerals, just the goal during the sweep
      this.hud.showIntro(t < 2.0 ? JOINING_TEXT : "");
      return;
    }
    const n = t < 0.8 ? 3 : t < 1.6 ? 2 : t < INTRO_S ? 1 : 0;
    this.hud.showIntro(n > 0 ? String(n) : t < INTRO_S + 0.5 ? "FIGHT!" : "");
    if (n !== this.lastCount) {
      this.lastCount = n;
      if (n > 0) this.fx.audio.count();
      else this.fx.audio.fight();
    }
  }

  // ── music intensity driver (result-05 A5) ──
  private driveMusic(frameDt: number, me: Unit | null): void {
    this.musicClock += frameDt;
    this.musicAcc += frameDt;
    if (this.musicAcc < MUSIC_SAMPLE_S) return;
    this.musicAcc = 0;
    if (this.world.phase !== "playing" || !me) return;
    // null until the audio unlock gesture — don't track state the music system
    // never heard, or it would come up out of sync after unlock
    const music = this.fx.audio.music;
    if (!music) return;
    const desired = this.musicDesired(this.world, me);
    if (desired > this.musicIntensity) {
      // escalate immediately
      this.musicIntensity = desired;
      this.musicLowSince = -1;
      music.setIntensity(desired);
    } else if (desired < this.musicIntensity) {
      // de-escalate only after sustained calm (drop hysteresis)
      if (this.musicLowSince < 0) this.musicLowSince = this.musicClock;
      else if (this.musicClock - this.musicLowSince >= MUSIC_DROP_HYST_S) {
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
    if (w.suddenDeath || w.matchTime - w.gameTime < 60) return 3;
    if (isInThrone(me.x, me.y) && this.enemyHeroNear(me, 0, 0, 11)) return 3;
    // 2: you lead, or you're close to the leader
    if (w.leaderId !== null && w.leaderId === me.team) return 2;
    const leader = this.leaderUnit(w);
    if (leader && leader.alive) {
      const dx = leader.x - me.x;
      const dy = leader.y - me.y;
      if (dx * dx + dy * dy < 400) return 2;
    }
    // 1: enemies near or recent combat
    if (this.enemyHeroNear(me, me.x, me.y, 14)) return 1;
    if (w.now - me.lastHitAt < 3000 || w.now - me.lastAttackAt < 3000) return 1;
    return 0;
  }

  private enemyHeroNear(me: Unit, x: number, y: number, r: number): boolean {
    const r2 = r * r;
    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || u.team === me.team) continue;
      const dx = u.x - x;
      const dy = u.y - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  }

  private leaderUnit(w: World): Unit | null {
    if (w.leaderId === null) return null;
    for (const u of w.units.values()) {
      if (u.kind === "hero" && u.team === w.leaderId) return u;
    }
    return null;
  }

  /** Feed QWER cooldown sweeps to the touch buttons (int-percent change-gated). */
  private feedTouchCooldowns(me: Unit): void {
    const touch = this.touch;
    if (!touch || !touch.active) return;
    const def = CHAMP_BY_ID[me.champId];
    if (!def) return;
    for (const key of ABILITY_KEYS) {
      const slot = me.abilities[key];
      let pct = 0;
      if (slot.rank < 1) {
        pct = 1; // locked reads as a full sweep (dimmed)
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
    const net = this.net;
    if (!net) return;
    if (net.connectionStatus !== "connected" || !net.playerId) return;

    this.localId = `h-${net.playerId}`;
    this.worldView.localId = this.localId;
    this.fx.localId = this.localId;
    this.fx.localOwnerId = net.playerId;

    // announce our champ pick (and re-announce so a migrated host learns it)
    if (this.world.now - this.joinResendAt > 3000 || this.joinResendAt === 0) {
      net.sendEvent(INTENT_EVENT, { kind: "join", champId: this.champId, name: this.name } satisfies Intent);
      this.joinResendAt = this.world.now;
    }

    // watch the host's broadcast for a stall; take over if it died
    this.sampleHostLiveness(net);
    if (!net.isHost && !this.forcedHost && this.shouldTakeOverHost(net)) {
      this.forcedHost = true;
      this.tookOverFrom = net.hostId;
      // CONTINUE the snapshot-synced world (rngState/seq/scores carried) — only
      // seed fresh if we somehow have nothing. Never wipe a live match.
      this.assign = {};
      if (this.world.units.size === 0) this.world = createWorld(ONLINE_SEED);
    }
    if (this.forcedHost && net.isHost) this.forcedHost = false;
    else if (this.forcedHost && net.hostId && net.hostId !== net.playerId && net.hostId !== this.tookOverFrom) {
      this.forcedHost = false;
    }

    const me = this.localUnit();
    if (me) this.readInput(me, this.amHost);

    if (this.amHost) {
      this.becomeHostIfNeeded();
      this.reconcileHeroes(net);
      this.acc += frameDt;
      let n = 0;
      while (this.acc >= SIM_DT && n < 5) {
        step(this.world);
        this.acc -= SIM_DT;
        n++;
      }
      if (this.world.fx.length) this.netFx.push(...this.world.fx);
      this.broadcast(frameDt);
    } else {
      const snap = net.sharedState["snap"];
      if (isSnapshot(snap)) applySnapshot(this.world, snap);
      const fxSeq = net.sharedState["fxSeq"];
      if (typeof fxSeq === "number" && fxSeq !== this.lastFxSeq) {
        this.lastFxSeq = fxSeq;
        const fx = net.sharedState["fx"];
        if (Array.isArray(fx)) this.world.fx.push(...(fx as World["fx"]));
      }
    }
  }

  /** Read controls → apply locally (host) or send as an intent (guest). */
  private readInput(me: Unit, host: boolean): void {
    // MOUSE mode while a menu owns the cursor (shop, end screen); ACTION mode
    // (locked pointer) the rest of the match. Controls no-ops when unchanged.
    this.controls.setMouseMode(this.hud.isShopOpen || this.world.phase === "ended");
    if (!me.alive) {
      if (host) setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      return;
    }
    let mv: { x: number; y: number };
    let attack: boolean;
    let castPoint: { x: number; y: number };

    if (this.touch?.active) {
      const a = this.touch.aimVec();
      if (a) {
        this.aimX = a.x;
        this.aimY = a.y;
      }
      mv = this.touch.moveVec();
      attack = this.touch.attackDown();
      castPoint = { x: me.x + this.aimX * 8, y: me.y + this.aimY * 8 };
    } else {
      // FPS-centered aim: heading comes from mouse turn, crosshair is dead
      // center. The character faces the crosshair; camera trails behind.
      if (!this.aimInit) {
        this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
        this.aimInit = true;
      }
      const yaw = this.controls.aimYaw();
      this.aimX = Math.sin(yaw);
      this.aimY = Math.cos(yaw);
      const { fwd, strafe } = this.controls.moveAxes();
      const rx = -this.aimY; // screen-right when looking along the aim
      const ry = this.aimX;
      let dx = this.aimX * fwd + rx * strafe;
      let dy = this.aimY * fwd + ry * strafe;
      const l = Math.hypot(dx, dy);
      if (l > 0) {
        dx /= l;
        dy /= l;
      }
      mv = { x: dx, y: dy };
      attack = this.controls.attackDown();
      castPoint = { x: me.x + this.aimX * 8, y: me.y + this.aimY * 8 };
    }

    if (host) {
      setHeroInput(me, mv.x, mv.y, this.aimX, this.aimY, attack);
    } else {
      this.net?.sendEvent(INTENT_EVENT, {
        kind: "input",
        mx: mv.x,
        my: mv.y,
        ax: this.aimX,
        ay: this.aimY,
        attack,
      } satisfies Intent);
    }

    const keys = [...this.controls.consumeAbilities(), ...(this.touch?.consumeAbilities() ?? [])];
    for (const key of keys) {
      // deny feedback is a pre-check (locked / beyond the buffer window) — a
      // requestCast returning false may just mean "buffered", which is not a
      // deny. The cast/intent is ALWAYS issued; the host stays authoritative.
      if (this.wouldDeny(me, key)) this.fx.audio.castDeny();
      if (host) {
        requestCast(this.world, me, key, { point: castPoint, dir: { x: this.aimX, y: this.aimY } });
      } else {
        this.net?.sendEvent(INTENT_EVENT, {
          kind: "cast",
          key,
          px: castPoint.x,
          py: castPoint.y,
          ax: this.aimX,
          ay: this.aimY,
        } satisfies Intent);
      }
    }

    // Space / touch JUMP: evasive hop (drain both edges every frame)
    const kbJump = this.controls.consumeJump();
    const tJump = this.touch?.consumeJump() ?? false;
    if (kbJump || tJump) {
      if (host) tryJump(this.world, me);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "jump" } satisfies Intent);
    }

    // Shift / touch DODGE: dodge-roll (i-frames) in the movement direction
    const kbDodge = this.controls.consumeDodge();
    const tDodge = this.touch?.consumeDodge() ?? false;
    if (kbDodge || tDodge) {
      if (host) requestDodge(this.world, me, mv.x, mv.y);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "dodge", mx: mv.x, my: mv.y } satisfies Intent);
    }

    // item actives: 5–0 keys + belt-chip taps (the only touch path to items)
    for (const slot of [...this.controls.consumeItems(), ...this.hud.consumeItemTaps()]) {
      if (host) useItemActive(this.world, me, slot, castPoint);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "useItem", slot, px: castPoint.x, py: castPoint.y } satisfies Intent);
    }

    const buy = this.controls.consumeBuy() || (this.touch?.consumeBuy() ?? false);
    if (buy && (this.canShop() || this.hud.isShopOpen)) {
      this.hud.toggleShop();
      if (this.hud.isShopOpen) this.hints.notifyShopOpened(); // early-dismiss the shop hint
    }
  }

  /** Locked, or on cooldown past the sim's buffer window → the press is a deny. */
  private wouldDeny(me: Unit, key: AbilityKey): boolean {
    const slot = me.abilities[key];
    return slot.rank < 1 || slot.readyAt - this.world.now > CAST_BUFFER_MS;
  }

  private requestBuy(itemId: string): void {
    const me = this.localUnit();
    if (!me) return;
    if (this.amHost) buyItem(this.world, me, itemId);
    else this.net?.sendEvent(INTENT_EVENT, { kind: "buy", itemId } satisfies Intent);
  }

  // ── host: receive intents ──
  private onNetEvent(event: string, payload: unknown, from: string): void {
    if (event !== INTENT_EVENT) return;
    const intent = payload as Intent;
    if (intent.kind === "join") {
      this.picks[from] = { champId: intent.champId, name: intent.name };
      return;
    }
    if (!this.amHost) return;
    const u = this.world.units.get(`h-${from}`);
    if (!u || !u.alive) return;
    // sanitize guest-supplied numbers — a malformed/malicious client must not
    // inject NaN/Inf into the authoritative sim (it would spread via separation)
    const f = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
    const fc = (n: unknown): number => clampArena(f(n));
    switch (intent.kind) {
      case "input":
        setHeroInput(u, clamp1(f(intent.mx)), clamp1(f(intent.my)), clamp1(f(intent.ax)), clamp1(f(intent.ay)), intent.attack === true);
        break;
      case "cast":
        // requestCast so guests get the same host-side input buffer as locals
        requestCast(this.world, u, intent.key, { point: { x: fc(intent.px), y: fc(intent.py) }, dir: { x: clamp1(f(intent.ax)), y: clamp1(f(intent.ay)) } });
        break;
      case "buy":
        if (typeof intent.itemId === "string") buyItem(this.world, u, intent.itemId);
        break;
      case "useItem":
        useItemActive(this.world, u, f(intent.slot), { x: fc(intent.px), y: fc(intent.py) });
        break;
      case "jump":
        tryJump(this.world, u);
        break;
      case "dodge":
        requestDodge(this.world, u, clamp1(f(intent.mx)), clamp1(f(intent.my)));
        break;
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
    for (const u of [...this.world.units.values()]) {
      if (u.kind !== "hero" || u.isBot) continue;
      if (!conns.includes(u.ownerId)) {
        this.world.units.delete(u.id);
        delete this.assign[u.ownerId];
      }
    }
    // assign stable slots + spawn known picks
    for (const connId of conns) {
      if (this.assign[connId] === undefined) this.assign[connId] = this.freeSlot();
      const id = `h-${connId}`;
      if (!this.world.units.has(id)) {
        const pick = this.picks[connId];
        if (pick) {
          spawnHero(this.world, {
            id,
            ownerId: connId,
            team: connId,
            champId: pick.champId,
            name: pick.name || "Player",
            isBot: false,
            slot: this.assign[connId]!,
          });
        }
      }
    }
    ensureBots(this.world);
  }

  private freeSlot(): number {
    const used = new Set<number>([
      ...Object.values(this.assign),
      ...[...this.world.units.values()].filter((u) => u.kind === "hero").map((u) => u.slot),
    ]);
    for (let s = 0; s < SPAWNS.length; s++) if (!used.has(s)) return s;
    return 0;
  }

  private broadcast(dt: number): void {
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) return;
    this.snapAcc = 0;
    this.fxSeqOut += 1;
    this.net?.updateSharedState({
      snap: encodeWorld(this.world),
      fx: this.netFx,
      fxSeq: this.fxSeqOut,
    });
    this.netFx = [];
  }

  // ── host-takeover (mirrors moba) ──
  private sampleHostLiveness(net: MultiplayerClient): void {
    const snap = net.sharedState["snap"];
    if (!isSnapshot(snap)) return;
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
    if (this.slowWindows < 2) return false;
    const me = net.playerId;
    if (!me) return false;
    const others = Object.keys(net.players).filter((id) => id !== net.hostId);
    if (others.length === 0) return true;
    others.sort();
    return me === others[0];
  }

  private canShop(): boolean {
    const me = this.localUnit();
    if (!me || !me.alive) return false;
    const sp = SPAWNS[me.slot % SPAWNS.length]!;
    return (me.x - sp.x) ** 2 + (me.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
  }

  dispose(): void {
    this.net?.destroy();
    this.statusEl.remove();
    this.hud.dispose();
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

const clamp1 = (n: number): number => (n < -1 ? -1 : n > 1 ? 1 : n);
const clampArena = (n: number): number => (n < -HALF ? -HALF : n > HALF ? HALF : n);

/** Champion for quick-start boots: ?champ → localStorage["ba-champ"] → default.
 *  Both sources are validated against the roster so a stale/typo'd id can never
 *  crash the boot. The menu's START writes the localStorage key. */
export function chosenChamp(): string {
  const fromUrl = new URLSearchParams(location.search).get("champ");
  if (fromUrl && CHAMP_BY_ID[fromUrl]) return fromUrl;
  const stored = localStorage.getItem("ba-champ");
  if (stored && CHAMP_BY_ID[stored]) return stored;
  return DEFAULT_CHAMP;
}

/** Player name for quick-start boots: ?name → localStorage["ba-name"] → "Player". */
export function chosenName(): string {
  const fromUrl = new URLSearchParams(location.search).get("name")?.trim();
  if (fromUrl) return fromUrl.slice(0, 14);
  const stored = localStorage.getItem("ba-name")?.trim();
  return stored ? stored.slice(0, 14) : "Player";
}
