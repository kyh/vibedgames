import { MultiplayerClient } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { SIM_DT, SNAPSHOT_HZ } from "../data/config";
import type { Team } from "../data/config";
import { HEROES, HERO_BY_ID } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import { ELEV_LIFT, WORLD, elevationFrac } from "../data/map";
import { autoLevel, castAbility, levelAbility, useItem } from "../sim/abilities";
import { dealDamage, isEnemy } from "../sim/combat";
import { dist2 } from "../sim/math";
import { buyItem, createWorld, dashHero, issueOrder, spawnHero, step } from "../sim/world";
import type { Order, Unit, World } from "../sim/types";
import { resumeAudio, sfx, toggleMute } from "../render/audio";
import { FONT } from "../render/font";
import { WorldView } from "../render/view";
import { INTENT_EVENT, MULTIPLAYER_HOST, PARTY, ROOM } from "../net/protocol";
import type { Intent } from "../net/protocol";
import { applySnapshot, emptyGuestWorld, encodeWorld, isSnapshot } from "../net/snapshot";

const TEAM_SIZE = 3;

// Keyboard-first scheme with hands split so nothing overlaps: MOVE with the arrow
// keys (right hand), ABILITIES on Q/W/E/R (left hand), F = dash, Space = attack.
const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
const DASH_KEY = "F";
export const SLOT_LABEL: Record<AbilityKey, string> = { Q: "Q", W: "W", E: "E", R: "R" };

export type FeedEntry =
  | { kind: "kill"; killer: string; victim: string; team: Team; at: number }
  | { kind: "notify"; text: string; tone: "good" | "bad" | "neutral"; at: number };

export class GameScene extends Phaser.Scene {
  private world!: World;
  private view!: WorldView;
  private playerId = "";
  private acc = 0;
  private labelTimer = 0;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private followGo = false;
  private heroChoice = "ironvow";
  private ended = false;
  private hitStopUntil = 0; // brief sim freeze on nearby hero kills (game feel)
  private moveKeys: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key> | null =
    null;
  private lastDir = { dx: 0, dy: 0 };
  private aimDir = { x: 1, y: 0 }; // last movement direction — drives keyboard ability aim
  uiBlocking = false; // set by the HUD while a modal (shop) is open — pauses hero input
  // kill feed / announcements drained from world.fx for the HUD (which reads them
  // before the WorldView clears world.fx each frame)
  readonly feed: FeedEntry[] = [];

  // multiplayer
  private online = false;
  private net: MultiplayerClient | null = null;
  private picks: Record<string, string> = {}; // connId -> defId (host)
  private assign: Record<string, { team: Team; slot: number }> = {}; // stable team/slot per conn (host)
  private joinedSelf = false;
  private snapAcc = 0;
  private netFx: World["fx"] = [];
  private fxSeqOut = 0; // host: increments per fx broadcast
  private lastFxSeq = -1; // guest: last fx batch ingested
  // stale-host takeover: a backgrounded/throttled tab stays "connected" and keeps
  // hosting a frozen game, so the server never migrates host and new players are
  // stuck spectating. We sample the broadcast snapshot's sim rate and, if it stalls,
  // the elected non-host player reseeds a fresh match and hosts it.
  private forcedHost = false;
  private tookOverFrom: string | null = null;
  private joinResendAt = 0; // re-announce our pick so a new/forced host learns it
  private rateAt0 = 0; // host-liveness sample window start (scene clock ms)
  private rateGameTime0 = -1; // snapshot gameTime at the window start
  private slowWindows = 0; // consecutive ~2s windows the host ran < 0.5× real-time

  constructor() {
    super("Game");
  }

  init(data: { heroId?: string; online?: boolean }): void {
    if (data?.heroId) this.heroChoice = data.heroId;
    this.online = !!data?.online;
  }

  /** Reset every mutable per-match field (the scene instance is reused on restart). */
  private resetMatchState(): void {
    this.playerId = "";
    this.acc = 0;
    this.labelTimer = 0;
    this.followGo = false;
    this.ended = false;
    this.hitStopUntil = 0;
    this.lastDir = { dx: 0, dy: 0 };
    this.aimDir = { x: 1, y: 0 };
    this.uiBlocking = false;
    this.net = null;
    this.picks = {};
    this.assign = {};
    this.joinedSelf = false;
    this.snapAcc = 0;
    this.netFx = [];
    this.fxSeqOut = 0;
    this.lastFxSeq = -1;
    this.forcedHost = false;
    this.tookOverFrom = null;
    this.joinResendAt = 0;
    this.rateAt0 = 0;
    this.rateGameTime0 = -1;
    this.slowWindows = 0;
    this.feed.length = 0;
    this.moveKeys = null;
  }

  create(): void {
    // Phaser reuses the scene instance across restarts (PLAY AGAIN / menu round-trips),
    // so reset all mutable per-match state here — otherwise stale fields (e.g. `ended`)
    // leak into the next match. See memory: phaser4-scene-instance-reuse.
    this.resetMatchState();

    this.view = new WorldView(this);
    this.view.buildTerrain();
    this.view.buildStructures();

    this.cam = this.cameras.main;
    this.cam.roundPixels = true;
    this.cam.setBackgroundColor("#0a0e16");
    this.applyZoom();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyZoom, this);

    if (this.online) this.startOnline();
    else this.startLocal();

    this.bindInput();
    this.scene.launch("Hud", { game: this });
    if (import.meta.env.DEV) {
      this.installDebug();
      // ?at=x,y drops the player at a world point on spawn so headless captures can
      // frame any region (terrain plateaus etc.) deterministically.
      const at = new URLSearchParams(window.location.search).get("at");
      const me = this.player;
      if (at && me) {
        const [ax, ay] = at.split(",").map(Number);
        if (Number.isFinite(ax) && Number.isFinite(ay)) {
          me.x = ax ?? me.x;
          me.y = ay ?? me.y;
        }
      }
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyZoom, this);
      this.net?.destroy();
    });

    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 600);
    }
  }

  // ---- modes ---------------------------------------------------------------
  private startLocal(): void {
    this.world = createWorld(1234);
    const player = spawnHero(this.world, this.heroChoice, "radiant", "you", false, 0);
    this.playerId = player.id;
    this.view.playerHeroId = player.id;
    this.view.playerTeam = player.team;
    pickRoster(this.heroChoice, TEAM_SIZE)
      .slice(1)
      .forEach((id, i) => spawnHero(this.world, id, "radiant", `botR${i}`, true, i + 1));
    pickRoster("emberhex", TEAM_SIZE).forEach((id, i) =>
      spawnHero(this.world, id, "dire", `botD${i}`, true, i),
    );
  }

  private startOnline(): void {
    // guests render this; the host overwrites its own with a real sim world
    this.world = emptyGuestWorld();
    this.net = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: PARTY,
      room: ROOM,
      onEvent: (event, payload, from) => this.onNetEvent(event, payload, from),
    });
  }

  private get amHost(): boolean {
    return !this.online || (this.net?.isHost ?? false) || this.forcedHost;
  }

  // ---- networking ----------------------------------------------------------
  private onNetEvent(event: string, payload: unknown, from: string): void {
    if (event !== INTENT_EVENT) return;
    const intent = payload as Intent;
    // record hero picks even as a guest, so if we later take over a stale host we
    // already know everyone's choice and can spawn their hero immediately.
    if (intent.kind === "join") {
      this.picks[from] = intent.defId;
      return;
    }
    if (!this.amHost) return; // only the host applies gameplay intents
    const u = this.world.units.get(`h-${from}`);
    if (!u || !u.alive) return;
    this.applyIntent(u, intent);
  }

  private applyIntent(u: Unit, intent: Intent): void {
    switch (intent.kind) {
      case "order":
        issueOrder(this.world, u, intent.order);
        break;
      case "cast":
        castAbility(this.world, u, {
          key: intent.key,
          point: intent.point,
          targetId: intent.targetId,
        });
        break;
      case "level":
        levelAbility(this.world, u, intent.key);
        break;
      case "buy":
        buyItem(this.world, u, intent.itemId);
        break;
      case "useItem": {
        const id = u.hero?.items[intent.slot];
        if (id) useItem(this.world, u, id, intent.point);
        break;
      }
      case "dash":
        dashHero(this.world, u, intent.dx, intent.dy);
        break;
      case "join":
        break;
    }
  }

  /** Host: ensure a hero exists per connected human + fill teams with bots.
   * Team/slot assignment is STABLE per connection (balanced on first sight) so a
   * later join never reshuffles existing players. A human's hero waits until we
   * know their pick (the join intent), so nobody spawns as the wrong hero. */
  private reconcileOnlineHeroes(): void {
    if (!this.net) return;
    const ids = Object.keys(this.net.players);
    const want = new Set<string>();
    const teamUsed: Record<Team, number> = { radiant: 0, dire: 0 };

    // assign newcomers to the lighter team, stably
    for (const id of ids) {
      if (!this.assign[id]) {
        const counts = { radiant: 0, dire: 0 };
        for (const a of Object.values(this.assign)) counts[a.team]++;
        const team: Team = counts.radiant <= counts.dire ? "radiant" : "dire";
        this.assign[id] = { team, slot: counts[team] };
      }
    }
    // drop assignments for departed connections
    for (const id of Object.keys(this.assign)) if (!ids.includes(id)) delete this.assign[id];

    for (const id of ids) {
      const a = this.assign[id]!;
      teamUsed[a.team] = Math.max(teamUsed[a.team], a.slot + 1);
      const hid = `h-${id}`;
      const pick = this.picks[id];
      if (!pick) continue; // wait for their hero choice
      want.add(hid);
      const existing = this.world.units.get(hid);
      if (!existing) {
        spawnHero(this.world, pick, a.team, id, false, a.slot);
      } else if (
        existing.hero &&
        existing.hero.defId !== pick &&
        existing.hero.level === 1 &&
        existing.hero.kills === 0
      ) {
        // pick arrived after a provisional spawn: respawn as the chosen hero
        this.world.units.delete(hid);
        spawnHero(this.world, pick, a.team, id, false, a.slot);
      }
    }
    // bots fill each team to TEAM_SIZE
    for (const team of ["radiant", "dire"] as Team[]) {
      for (let s = teamUsed[team]; s < TEAM_SIZE; s++) {
        const hid = `h-bot-${team}-${s}`;
        want.add(hid);
        if (!this.world.units.has(hid)) {
          const def =
            pickRoster(team === "radiant" ? "ironvow" : "emberhex", s + 1)[s] ?? "ironvow";
          spawnHero(this.world, def, team, `bot-${team}-${s}`, true, s);
        }
      }
    }
    // remove hero units no longer wanted (departed humans / surplus bots)
    for (const [id, u] of this.world.units) {
      if (u.kind === "hero" && !want.has(id)) this.world.units.delete(id);
    }
  }

  private becomeHostIfNeeded(): void {
    // first host seeds the sim world (replacing the empty guest world)
    if (this.amHost && (this.world.units.size === 0 || !hasStructures(this.world))) {
      this.world = createWorld(1234);
    }
  }

  // ---- player commands (apply as authority, else send intent) --------------
  private cmd(intent: Intent): void {
    if (this.amHost) {
      const me = this.player;
      if (me) this.applyIntent(me, intent);
    } else {
      this.net?.sendEvent(INTENT_EVENT, intent);
    }
  }

  get worldRef(): World {
    return this.world;
  }
  get player(): Unit | undefined {
    return this.playerId ? this.world.units.get(this.playerId) : undefined;
  }
  /** The currently-visible world rectangle, for the minimap viewport box. */
  get cameraView(): Phaser.Geom.Rectangle {
    return this.cam.worldView;
  }
  /** Hand the HUD any feed entries collected since the last frame, then clear. */
  drainFeed(): FeedEntry[] {
    if (this.feed.length === 0) return [];
    const out = this.feed.slice();
    this.feed.length = 0;
    return out;
  }

  private applyZoom(): void {
    // Fixed follow-cam: zoom scales only with viewport height (no scroll-zoom).
    this.cam.setZoom(Phaser.Math.Clamp(this.scale.height / 900, 0.55, 1.3));
  }

  // ---- input ---------------------------------------------------------------
  private bindInput(): void {
    this.input.mouse?.disableContextMenu();
    // Mouse is a full complement to the keyboard scheme (which stays the primary,
    // keyboard-first control): LEFT or RIGHT click moves to the point, or attacks
    // an enemy clicked on. Keyboard steering/abilities remain fully usable.
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      resumeAudio();
      if (this.uiBlocking) return; // shop/modal open — ignore world clicks
      if (!(p.leftButtonDown() || p.rightButtonDown())) return;
      // don't move when the click was actually on a HUD widget (minimap, ability
      // bar, item slots, shop) — that scene sits on top and handles its own clicks.
      const hud = this.scene.get("Hud");
      if (hud?.input && hud.input.hitTestPointer(p).length > 0) return;
      this.issueClickOrder(p);
    });

    const kb = this.input.keyboard;
    if (!kb) return;
    // abilities on Q/W/E/R (left hand); Shift/Ctrl + key levels it
    for (const key of ABILITY_KEYS) {
      kb.on(`keydown-${key}`, (e: KeyboardEvent) => {
        if (e.shiftKey || e.ctrlKey) this.levelSlot(key);
        else this.castSlot(key);
      });
    }
    kb.on(`keydown-${DASH_KEY}`, () => this.dash());
    kb.on("keydown-H", () => this.cmd({ kind: "order", order: { type: "fountain" } }));
    ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"].forEach((code, i) => {
      kb.on(`keydown-${code}`, () => this.useItemSlot(i));
    });
    kb.on("keydown-M", () => toggleMute());

    // Movement: arrow keys (right hand, held). Space = basic attack. Camera follows.
    const KC = Phaser.Input.Keyboard.KeyCodes;
    this.moveKeys = {
      up: kb.addKey(KC.UP, true),
      down: kb.addKey(KC.DOWN, true),
      left: kb.addKey(KC.LEFT, true),
      right: kb.addKey(KC.RIGHT, true),
    };
    kb.on("keydown-SPACE", (e: KeyboardEvent) => {
      e.preventDefault?.();
      this.spaceAttack();
    });
  }

  /** Poll held arrow keys and stream a direction order when it changes. */
  private pollMovement(): void {
    if (!this.moveKeys) return;
    const me = this.player;
    // while dead/unspawned or a modal (shop) is open, forget the last direction so a
    // still-held key re-fires a fresh order the moment control returns.
    if (!me || !me.alive || this.uiBlocking) {
      if (this.uiBlocking && (this.lastDir.dx !== 0 || this.lastDir.dy !== 0))
        this.cmd({ kind: "order", order: { type: "hold" } });
      this.lastDir = { dx: 0, dy: 0 };
      return;
    }
    const k = this.moveKeys;
    let dx = 0;
    let dy = 0;
    if (k.left.isDown) dx -= 1;
    if (k.right.isDown) dx += 1;
    if (k.up.isDown) dy -= 1;
    if (k.down.isDown) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      this.aimDir = { x: dx / len, y: dy / len }; // remember facing for keyboard ability aim
    }
    if (dx === this.lastDir.dx && dy === this.lastDir.dy) return; // only on change
    this.lastDir = { dx, dy };
    if (dx === 0 && dy === 0) this.cmd({ kind: "order", order: { type: "hold" } });
    else this.cmd({ kind: "order", order: { type: "moveDir", dx, dy } });
  }

  private spaceAttack(): void {
    const me = this.player;
    if (!me || !me.alive || this.uiBlocking) return;
    const target = this.nearestAttackTarget(me, 750);
    if (target) this.cmd({ kind: "order", order: { type: "attackUnit", targetId: target.id } });
  }

  /** Quick dodge in the held/facing direction (host validates the cooldown). */
  private dash(): void {
    const me = this.player;
    if (!me || !me.alive || this.uiBlocking) return;
    const moving = this.lastDir.dx !== 0 || this.lastDir.dy !== 0;
    const dx = moving ? this.lastDir.dx : this.aimDir.x;
    const dy = moving ? this.lastDir.dy : this.aimDir.y;
    this.cmd({ kind: "dash", dx, dy });
  }

  /** Pull kill/announce events out of world.fx for the HUD before the view drains them. */
  private collectFeed(): void {
    const now = this.time.now;
    const me = this.player;
    for (const fx of this.world.fx) {
      if (fx.t === "kill")
        this.feed.push({
          kind: "kill",
          killer: fx.killer,
          victim: fx.victim,
          team: fx.team,
          at: now,
        });
      else if (fx.t === "notify")
        this.feed.push({ kind: "notify", text: fx.text, tone: fx.tone, at: now });
      else if (fx.t === "death" && fx.kind === "hero" && me && dist2(me, fx) < 900 * 900) {
        // hit-stop: a beat of frozen sim when a hero dies near you sells the kill
        this.hitStopUntil = now + 90;
      }
    }
    if (this.feed.length > 40) this.feed.splice(0, this.feed.length - 40);
  }

  /** HUD minimap → world: order the hero to travel to a clicked map point. */
  moveToWorldPoint(x: number, y: number): void {
    const me = this.player;
    if (!me || !me.alive) return;
    this.lastDir = { dx: 0, dy: 0 };
    this.cmd({ kind: "order", order: { type: "attackMove", to: { x, y } } });
  }

  private nearestAttackTarget(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestD = range * range;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) continue;
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      if (u.statuses.some((s) => s.kind === "untargetable")) continue;
      const d = dist2(me, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private issueClickOrder(p: Phaser.Input.Pointer): void {
    const me = this.player;
    if (!me || !me.alive) return;
    this.lastDir = { dx: 0, dy: 0 }; // a mouse order supersedes held-key steering
    const wp = this.cam.getWorldPoint(p.x, p.y);
    const enemy = this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);
    if (enemy) this.cmd({ kind: "order", order: { type: "attackUnit", targetId: enemy.id } });
    else this.cmd({ kind: "order", order: { type: "move", to: { x: wp.x, y: wp.y } } });
  }

  /** Cast an ability, aimed entirely from the keyboard. */
  castSlot(key: AbilityKey): void {
    const me = this.player;
    if (!me || !me.alive || !me.hero || this.uiBlocking) return;
    const def = HERO_BY_ID[me.hero.defId]?.abilities[key];
    if (!def) return;
    if (def.targeting === "unit") {
      const wantAlly = def.effect === "brewkeeper:Q";
      const target = wantAlly
        ? (this.lowestAllyInRange(me, def.castRange) ?? me)
        : this.nearestEnemy(me, def.castRange);
      if (target) this.cmd({ kind: "cast", key, targetId: target.id });
    } else if (def.targeting === "point") {
      const r = def.castRange;
      let point: { x: number; y: number };
      if (r <= 0) {
        point = { x: me.x, y: me.y }; // self-centred (e.g. Last Call)
      } else if (this.lastDir.dx !== 0 || this.lastDir.dy !== 0) {
        // FREE-AIM: while moving, fire along the direction you're steering
        point = { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
      } else {
        // stationary: soft auto-aim at the nearest enemy in range, else last facing
        const foe = this.nearestEnemy(me, r);
        point = foe
          ? { x: foe.x, y: foe.y }
          : { x: me.x + this.aimDir.x * r, y: me.y + this.aimDir.y * r };
      }
      this.cmd({ kind: "cast", key, point });
    } else {
      this.cmd({ kind: "cast", key });
    }
  }

  levelSlot(key: AbilityKey): void {
    this.cmd({ kind: "level", key });
  }

  private lowestAllyInRange(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestPct = 1.01;
    const r2 = range * range;
    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || isEnemy(me, u)) continue;
      if (dist2(me, u) > r2) continue;
      const pct = u.hp / u.maxHp;
      if (pct < bestPct) {
        bestPct = pct;
        best = u;
      }
    }
    return best;
  }

  private useItemSlot(i: number): void {
    const me = this.player;
    if (!me?.hero?.items[i]) return;
    const p = this.input.activePointer;
    const wp = this.cam.getWorldPoint(p.x, p.y);
    this.cmd({ kind: "useItem", slot: i, point: { x: wp.x, y: wp.y } });
  }

  buyItemForPlayer(id: string): boolean {
    const me = this.player;
    if (this.amHost && me) return buyItem(this.world, me, id);
    this.cmd({ kind: "buy", itemId: id });
    return true; // optimistic; host validates
  }
  useItemForPlayer(i: number): void {
    this.useItemSlot(i);
  }

  private unitAt(x: number, y: number, pred: (u: Unit) => boolean): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.world.units.values()) {
      if (!pred(u)) continue;
      // structures are clickable attack targets too — but only once their tier
      // gate is open, so a click on a protected tower falls through to a move
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      const r = (u.radius + 28) * (u.radius + 28);
      // units on high ground render lifted, so test against their on-screen position
      const ly = u.y - elevationFrac(u.x, u.y) * ELEV_LIFT;
      const d = dist2({ x, y }, { x: u.x, y: ly });
      if (d <= r && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Mark whoever the player is engaging with the Cursor_04 reticle. Resolves, in
   *  priority: explicit attack order → current swing → the enemy the hero is set to
   *  auto-attack (so it persists between swings) → the enemy under the cursor. */
  private updateTargetReticle(): void {
    const me = this.player;
    if (!me || !me.alive) {
      this.view.setTarget("");
      return;
    }
    let id = "";
    if (me.order.type === "attackUnit") {
      const t = this.world.units.get(me.order.targetId);
      if (t && t.alive && isEnemy(me, t)) id = t.id;
    }
    if (!id && me.pendingAttack) {
      const t = this.world.units.get(me.pendingAttack.targetId);
      if (t && t.alive && isEnemy(me, t)) id = t.id;
    }
    // auto-attack acquisition: while holding/idle/attack-moving the hero attacks the
    // nearest enemy in range — keep the reticle pinned to it the whole time.
    if (!id && (me.order.type === "idle" || me.order.type === "hold" || me.order.type === "attackMove")) {
      const t = this.engageTarget(me);
      if (t) id = t.id;
    }
    if (!id) {
      const p = this.input.activePointer;
      const wp = this.cam.getWorldPoint(p.x, p.y);
      const hov = this.unitAt(wp.x, wp.y, (u) => isEnemy(me, u) && u.alive);
      if (hov) id = hov.id;
    }
    this.view.setTarget(id);
  }

  /** Nearest enemy within auto-attack reach (mirrors the sim's acquire range). */
  private engageTarget(me: Unit): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive) continue;
      if (u.kind === "structure" && !u.structure?.attackable) continue;
      if (u.statuses.some((s) => s.kind === "untargetable")) continue;
      const reach = me.attackRange + me.radius + u.radius + 30;
      const d = dist2(me, u);
      if (d <= reach * reach && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private nearestEnemy(me: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestD = range * range;
    for (const u of this.world.units.values()) {
      if (!isEnemy(me, u) || !u.alive || u.kind === "structure") continue;
      const d = dist2(me, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  // ---- loop ----------------------------------------------------------------
  override update(_t: number, deltaMs: number): void {
    const dt = Math.min(0.05, deltaMs / 1000);
    this.pollMovement();
    if (this.online) this.tickOnline(dt);
    else this.tickHost(dt);

    this.collectFeed();
    this.updateTargetReticle();
    this.view.sync(this.world, dt);
    this.labelTimer += dt;
    if (this.labelTimer > 0.25) {
      this.labelTimer = 0;
      this.view.refreshLabels(this.world);
    }
    this.updateCamera(dt);

    if (this.world.phase === "ended" && !this.ended) {
      this.ended = true;
      this.showResult();
    }
  }

  private tickHost(dt: number): void {
    if (this.time.now < this.hitStopUntil) return; // hit-stop: hold the sim a beat
    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < 5) {
      step(this.world, SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }
    const me = this.player;
    if (me?.hero && me.hero.abilityPoints > 0) autoLevel(this.world, me);
  }

  private tickOnline(dt: number): void {
    const net = this.net;
    if (!net || net.connectionStatus !== "connected") return;
    // announce our hero pick once
    if (!this.joinedSelf && net.playerId) {
      this.joinedSelf = true;
      this.playerId = `h-${net.playerId}`;
      this.view.playerHeroId = this.playerId;
      net.sendEvent(INTENT_EVENT, { kind: "join", defId: this.heroChoice } satisfies Intent);
      this.joinResendAt = this.time.now + 3000;
    }
    // periodically re-announce our pick so a host that joined/took over after us
    // still learns which hero to spawn for us.
    if (this.joinedSelf && this.time.now >= this.joinResendAt) {
      this.joinResendAt = this.time.now + 3000;
      net.sendEvent(INTENT_EVENT, { kind: "join", defId: this.heroChoice } satisfies Intent);
    }

    // watch the host's broadcast for a stall and take over if it's dead
    this.sampleHostLiveness(net);
    if (!net.isHost && !this.forcedHost && this.shouldTakeOverHost(net)) {
      this.forcedHost = true;
      this.tookOverFrom = net.hostId;
      this.world = createWorld(1234); // fresh match; keep accumulated hero picks
      this.assign = {};
    }
    // server promoted us to real host → fold the takeover into the normal path;
    // or it migrated to a different live host → yield back to a guest.
    if (this.forcedHost && net.isHost) this.forcedHost = false;
    else if (
      this.forcedHost &&
      net.hostId &&
      net.hostId !== net.playerId &&
      net.hostId !== this.tookOverFrom
    )
      this.forcedHost = false;

    if (this.amHost) {
      this.becomeHostIfNeeded();
      this.reconcileOnlineHeroes();
      // ensure host's own pick recorded
      if (net.playerId && !this.picks[net.playerId]) this.picks[net.playerId] = this.heroChoice;
      // capture fx for the network before our own renderer drains them
      if (this.world.fx.length) this.netFx.push(...this.world.fx);
      this.tickHost(dt);
      // set my team for HUD coloring
      const me = this.player;
      if (me) this.view.playerTeam = me.team;
      this.broadcast(dt);
    } else {
      // guest: render the latest snapshot
      const snap = net.sharedState["snap"];
      if (isSnapshot(snap)) applySnapshot(this.world, snap);
      // fx persists in sharedState between the host's ~15Hz broadcasts; ingest each
      // batch exactly once (the guest's update runs ~60fps) to avoid 4x-duplicated
      // hit numbers / explosions / kill-feed lines.
      const fxSeq = net.sharedState["fxSeq"];
      if (typeof fxSeq === "number" && fxSeq !== this.lastFxSeq) {
        this.lastFxSeq = fxSeq;
        const fx = net.sharedState["fx"];
        if (Array.isArray(fx)) this.world.fx.push(...(fx as World["fx"]));
      }
      const me = this.player;
      if (me) this.view.playerTeam = me.team;
    }
  }

  /** Sample the broadcast snapshot's sim rate over ~2s windows. A healthy host
   *  advances gameTime at ~1×; a throttled/backgrounded one crawls (<0.5×) and an
   *  ended/frozen one is 0. Counts consecutive slow windows. */
  private sampleHostLiveness(net: MultiplayerClient): void {
    const snap = net.sharedState["snap"];
    if (!isSnapshot(snap)) return;
    const gt = snap.gameTime;
    const now = this.time.now;
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

  /** Should we seize a stalled host's room? True when the snapshot is ended, or
   *  has run slow for two windows (~4s), AND we're the elected candidate. */
  private shouldTakeOverHost(net: MultiplayerClient): boolean {
    const snap = net.sharedState["snap"];
    const ended = isSnapshot(snap) && snap.phase === "ended";
    if (!ended && this.slowWindows < 2) return false;
    return this.isTakeoverCandidate(net);
  }

  /** Exactly one client takes over: the lowest-id connected player that ISN'T the
   *  (stale) host — deterministic, so peers don't all reseed at once. */
  private isTakeoverCandidate(net: MultiplayerClient): boolean {
    const me = net.playerId;
    if (!me) return false;
    const others = Object.keys(net.players).filter((id) => id !== net.hostId);
    if (others.length === 0) return true;
    others.sort();
    return me === others[0];
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

  private updateCamera(dt: number): void {
    const me = this.player;
    const fallback =
      this.world.units.get(`${me?.team === "dire" ? "d" : "r"}-ancient`) ??
      this.world.units.get("r-ancient");
    const target = me && me.alive ? me : fallback;
    if (!target) return;
    const cam = this.cam;
    const hw = cam.width / (2 * cam.zoom);
    const hh = cam.height / (2 * cam.zoom);
    const cx = Phaser.Math.Clamp(target.x, hw, WORLD.width - hw);
    const cy = Phaser.Math.Clamp(target.y, hh, WORLD.height - hh);
    if (!this.followGo) {
      cam.setScroll(cx - hw, cy - hh);
      this.followGo = true;
    } else {
      const k = 1 - Math.pow(0.0001, dt);
      cam.setScroll(
        Phaser.Math.Linear(cam.scrollX, cx - hw, k),
        Phaser.Math.Linear(cam.scrollY, cy - hh, k),
      );
    }
  }

  private showResult(): void {
    const myTeam = this.player?.team ?? "radiant";
    const win = this.world.winner === myTeam;
    sfx.victory(win);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const veil = this.add
      .rectangle(cx, cy, this.scale.width, this.scale.height, 0x05080e, 0)
      .setScrollFactor(0)
      .setDepth(99990);
    this.tweens.add({ targets: veil, fillAlpha: 0.55, duration: 600 });

    const ribbon = this.add
      .nineslice(
        cx,
        cy - 70,
        win ? "ui-ribbon-yellow" : "ui-ribbon-red",
        0,
        560,
        120,
        58,
        58,
        22,
        22,
      )
      .setScrollFactor(0)
      .setDepth(99998)
      .setScale(0);
    const txt = this.add
      .text(cx, cy - 78, win ? "VICTORY" : "DEFEAT", {
        fontFamily: FONT,
        fontSize: "72px",
        color: win ? "#5a3a10" : "#f4eee0",
        stroke: win ? "#fff3c4" : "#3a1410",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(99999);
    txt.setScale(0);
    this.tweens.add({ targets: [ribbon, txt], scale: 1, duration: 500, ease: "Back.Out" });

    let clicked = false;
    const mkBtn = (dx: number, label: string, color: "blue" | "red", onClick: () => void) => {
      const b = this.add
        .nineslice(cx + dx, cy + 60, `ui-btn-${color}`, 0, 250, 60, 28, 28, 20, 26)
        .setScrollFactor(0)
        .setDepth(99999)
        .setInteractive({ useHandCursor: true });
      const t = this.add
        .text(cx + dx, cy + 56, label, { fontFamily: FONT, fontSize: "19px", color: "#1e3a44" })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(100000);
      b.on("pointerover", () => this.tweens.add({ targets: [b, t], scale: 1.05, duration: 100 }));
      b.on("pointerout", () => this.tweens.add({ targets: [b, t], scale: 1, duration: 100 }));
      b.on("pointerdown", () => {
        if (clicked) return; // ignore double-clicks / the other button once one fires
        clicked = true;
        b.setTexture(`ui-btn-${color}-pressed`);
        t.setText("…").setY(cy + 60);
        this.time.delayedCall(40, onClick);
      });
      b.setScale(0);
      t.setScale(0);
      this.tweens.add({ targets: [b, t], scale: 1, duration: 360, delay: 320, ease: "Back.Out" });
    };
    if (!this.online) {
      mkBtn(-140, "⟳  PLAY AGAIN", "blue", () => {
        this.scene.stop("Hud");
        this.scene.start("Game", { heroId: this.heroChoice, online: false });
      });
    }
    mkBtn(this.online ? 0 : 140, "⌂  BACK TO MENU", "red", () => {
      this.net?.destroy();
      this.scene.stop("Hud");
      this.scene.start("Menu");
    });
  }

  private installDebug(): void {
    (window as unknown as { __moba?: unknown }).__moba = {
      scene: this,
      world: this.world,
      player: () => this.player,
      step: (n: number) => {
        for (let i = 0; i < n; i++) step(this.world, SIM_DT);
      },
      order: (o: Order) => {
        const me = this.player;
        if (me) issueOrder(this.world, me, o);
      },
      cast: (key: AbilityKey, point?: { x: number; y: number }, targetId?: string) => {
        const me = this.player;
        if (me) castAbility(this.world, me, { key, point, targetId });
      },
      kill: (id: string) => {
        const u = this.world.units.get(id);
        if (u) dealDamage(this.world, this.player ?? null, u, 1e9, "pure", {});
      },
    };
  }
}

function hasStructures(w: World): boolean {
  return w.units.has("r-ancient");
}

function pickRoster(first: string, n: number): string[] {
  const ids = [first];
  for (const h of HEROES) {
    if (ids.length >= n) break;
    if (!ids.includes(h.id)) ids.push(h.id);
  }
  return ids;
}
