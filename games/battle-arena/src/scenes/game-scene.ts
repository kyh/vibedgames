// Game scene — runs local (vs bots) or online (host-authoritative). The sim is
// identical in both; only authority + transport differ. Mirrors games/moba:
// guests send INTENT events and render snapshots; the host simulates and
// broadcasts under sharedState.snap, with stale-host takeover.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL, SHOP_RADIUS, SIM_DT } from "../data/config";
import { DEFAULT_CHAMP } from "../data/champions";
import { HALF, SPAWNS } from "../data/map";
import { terrainHeight } from "../data/terrain";
import type { AbilityKey, Unit, World } from "../sim/types";
import { castAbility, useItemActive } from "../sim/abilities";
import { buyItem, createWorld, ensureBots, setHeroInput, spawnHero, step, tryDodge, tryJump } from "../sim/world";
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

const ONLINE_SEED = 0xbada55;

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
  private crosshairEl: HTMLDivElement;

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
      this.world = createWorld(0x1234abc);
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
    this.fx = new Fx(view.scene, view);
    this.fx.localId = this.localId;
    this.worldView.fx = this.fx;
    this.hud = new Hud(view, this.fx, {
      buy: (id) => this.requestBuy(id),
      canShop: () => this.canShop(),
    });

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:800 22px ui-monospace,monospace;color:#9fd0ff;text-shadow:0 2px 6px #000;z-index:9;pointer-events:none";
    document.body.appendChild(this.statusEl);

    // fixed center crosshair — the aim reticle (FPS-style centered camera)
    this.crosshairEl = document.createElement("div");
    this.crosshairEl.style.cssText =
      "position:fixed;left:50%;top:50%;width:26px;height:26px;transform:translate(-50%,-50%);z-index:8;pointer-events:none;" +
      "background:" +
      "radial-gradient(circle,rgba(255,255,255,.95) 0 1.5px,transparent 2px)," +
      "linear-gradient(rgba(255,255,255,.85),rgba(255,255,255,.85)) 50% 0/2px 8px no-repeat," +
      "linear-gradient(rgba(255,255,255,.85),rgba(255,255,255,.85)) 50% 100%/2px 8px no-repeat," +
      "linear-gradient(rgba(255,255,255,.85),rgba(255,255,255,.85)) 0 50%/8px 2px no-repeat," +
      "linear-gradient(rgba(255,255,255,.85),rgba(255,255,255,.85)) 100% 50%/8px 2px no-repeat;" +
      "filter:drop-shadow(0 1px 2px #000)";
    document.body.appendChild(this.crosshairEl);
  }

  private get amHost(): boolean {
    return !this.net || (this.net.isHost ?? false) || this.forcedHost;
  }

  private localUnit(): Unit | null {
    return this.world.units.get(this.localId) ?? null;
  }

  // ── per-frame ──
  update(frameDt: number): void {
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
      this.hud.update(this.world, me);
    } else {
      this.statusEl.textContent =
        this.net && this.net.connectionStatus !== "connected" ? "Connecting…" : "Joining the arena…";
    }
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    const pitch = this.touch?.active ? 0 : this.controls.aimPitch();
    this.view.follow(cx, cy, this.aimX, this.aimY, pitch, rdt, terrainHeight(cx, cy));
    this.view.tickAura(this.world.gameTime);
    this.environment.update(this.world.gameTime);
    this.view.render();
  }

  // ── local mode ──
  private tickLocal(frameDt: number): void {
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

  // ── online mode ──
  private tickOnline(frameDt: number): void {
    const net = this.net;
    if (!net) return;
    if (net.connectionStatus !== "connected" || !net.playerId) return;

    this.localId = `h-${net.playerId}`;
    this.worldView.localId = this.localId;
    this.fx.localId = this.localId;

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
      if (host) castAbility(this.world, me, key, { point: castPoint, dir: { x: this.aimX, y: this.aimY } });
      else
        this.net?.sendEvent(INTENT_EVENT, {
          kind: "cast",
          key,
          px: castPoint.x,
          py: castPoint.y,
          ax: this.aimX,
          ay: this.aimY,
        } satisfies Intent);
    }

    // Space: evasive hop
    if (this.controls.consumeJump()) {
      if (host) tryJump(this.world, me);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "jump" } satisfies Intent);
    }

    // Shift: dodge-roll (i-frames) in the movement direction
    if (this.controls.consumeDodge()) {
      if (host) tryDodge(this.world, me, mv.x, mv.y);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "dodge", mx: mv.x, my: mv.y } satisfies Intent);
    }

    for (const slot of this.controls.consumeItems()) {
      if (host) useItemActive(this.world, me, slot, castPoint);
      else this.net?.sendEvent(INTENT_EVENT, { kind: "useItem", slot, px: castPoint.x, py: castPoint.y } satisfies Intent);
    }

    const buy = this.controls.consumeBuy() || (this.touch?.consumeBuy() ?? false);
    if (buy && (this.canShop() || this.hud.isShopOpen)) this.hud.toggleShop();
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
        castAbility(this.world, u, intent.key, { point: { x: fc(intent.px), y: fc(intent.py) }, dir: { x: clamp1(f(intent.ax)), y: clamp1(f(intent.ay)) } });
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
        tryDodge(this.world, u, clamp1(f(intent.mx)), clamp1(f(intent.my)));
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
    this.crosshairEl.remove();
    this.hud.dispose();
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

const clamp1 = (n: number): number => (n < -1 ? -1 : n > 1 ? 1 : n);
const clampArena = (n: number): number => (n < -HALF ? -HALF : n > HALF ? HALF : n);

export function chosenChamp(): string {
  return new URLSearchParams(location.search).get("champ") ?? DEFAULT_CHAMP;
}
