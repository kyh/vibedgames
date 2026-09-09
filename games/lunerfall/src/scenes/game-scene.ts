import { BlendModes, Scene, Scenes } from "phaser";

import { attachVirtualGamepad } from "@vibedgames/gamepad/phaser";
import type { ButtonOptions, PhaserGamepad, Viewport } from "@vibedgames/gamepad/phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, MAX_STEPS, STEP } from "../config";
import { HERO_NAMES } from "../data/animations";
import type { EnemyName, HeroName } from "../data/animations";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { HEROES } from "../data/heroes";
import type { HeroDef } from "../data/heroes";
import { bankRun, loadMeta, recordBestScore } from "../data/meta";
import { RELICS } from "../data/relics";
import type { RunMods } from "../data/relics";
import { parseRoomType } from "../data/rooms";
import type { RoomDef, RoomType } from "../data/rooms";
import { Player } from "../entities/player";
import { isJsonString } from "../net/json";
import type { NetSession } from "../net/session";
import type { JsonValue } from "../net/json";
import { ExpeditionHud } from "../expedition-hud";
import type { ExpeditionOffer } from "../expedition-hud";
import { newRoomState } from "../state/room-state";
import type { MerchantItem, RoomState } from "../state/room-state";
import { newRunState } from "../state/run-state";
import type { RunState } from "../state/run-state";
import { livePlayers, newSeatState } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { dust, wallSmoke } from "../sys/fx";
import { diag } from "../sys/diag";
import { Grid } from "../sys/grid";
import { reseed, unseed } from "../sys/rng";
import { RunManager } from "../sys/run";
import { Input, NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";
import { gameInset, isCoarse, REDUCED_MOTION, touchHudBand } from "../sys/screen";
import type { VersusMatch } from "../sys/versus";
import { mountTouchHud, syncTouchHud } from "../touch-hud";
import { BannerHud } from "./banner-hud";
import { CheckpointSync } from "./checkpoint-sync";
import { Combat } from "./combat";
import { GuestSync } from "./guest-sync";
import { HostNet } from "./host-net";
import { LastStand } from "./last-stand";
import { OnlineFlow } from "./online-flow";
import { RoomBuilder } from "./room-builder";
import { RoomProgress } from "./room-progress";
import type { SceneChrome, SceneHooks } from "./scene-hooks";
import { TrailerStaging } from "./trailer-staging";
import type { TrailerInputs, TrailerStageOpts, TrailerWorld } from "./trailer-staging";
import { VersusFlow } from "./versus-flow";

// An on-screen action button — a ButtonOptions that definitely has a place and
// a size, so the cluster it belongs to can be measured.
type FixedButton = ButtonOptions & {
  position: NonNullable<ButtonOptions["position"]>;
  radius: number;
};

/** Top-left corner of the action cluster's bounding box, with thumb padding. */
const clusterBounds = (buttons: FixedButton[], v: Viewport) => {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  for (const b of buttons) {
    const c = b.position(v);
    left = Math.min(left, c.x - b.radius);
    top = Math.min(top, c.y - b.radius);
  }
  return { left: left - 10, top: top - 10 };
};

// Run-driven scene: RunManager stitches typed rooms; the scene owns the run,
// room and seat state objects, the frame loop and the chrome, and hands each
// concern to a collaborator wired in create() with the state it mutates plus
// this scene as its SceneHooks:
//   rooms       builds/tears down a room (room-builder.ts)
//   combat      damage, offense, projectiles (combat.ts)
//   progress    rewards, clear condition, doors (room-progress.ts)
//   lastStand   co-op down/revive (last-stand.ts)
//   versus      online duel flow (versus-flow.ts)
//   online      connection + authority + expedition begin/restart (online-flow.ts)
//   hostNet     host broadcast, remote presence + input (host-net.ts)
//   guest       guest snapshot apply + prediction reconcile (guest-sync.ts)
//   checkpoint  expedition checkpoint encode/adopt (checkpoint-sync.ts)
//   banners     centre-screen cue line (banner-hud.ts)
//   trailer     ?trailer=1 staging (trailer-staging.ts)
// Phaser reuses the scene instance across start(): every state object and
// collaborator is rebuilt in create(), so nothing from a previous run —
// destroyed sprites, a stale session, a guest's puppets — can leak into this one.
export class GameScene extends Scene implements SceneHooks {
  private readonly expedition = new RunManager();
  private run!: RunState;
  private room!: RoomState;
  private seat!: SeatState;
  private chrome!: SceneChrome;
  private banners!: BannerHud;
  private rooms!: RoomBuilder;
  private trailer!: TrailerStaging;
  private lastStand!: LastStand;
  private versus!: VersusFlow;
  private combat!: Combat;
  private progress!: RoomProgress;
  private hostNet!: HostNet;
  private guest!: GuestSync;
  private checkpoint!: CheckpointSync;
  private online!: OnlineFlow;
  private controls!: Input;
  private gamepad!: PhaserGamepad;
  private expeditionHud?: ExpeditionHud;
  private touch = false;

  private demo = false;
  private demoT = 0;
  private prevJump = false;
  private prevDash = false;
  private prevAtk = false;
  private prevSpecial = false;

  constructor() {
    super("game");
  }

  /**
   * True only when connected to a real party room (not the solo fallback) —
   * used by the wrapper's pause handler so it never freezes a co-op/versus
   * session another player is relying on.
   */
  isOnline(): boolean {
    return this.seat.session !== undefined && !this.seat.session.offline;
  }

  /** Versus binds Escape to "leave the duel" — the wrapper pause defers to it. */
  isVersus(): boolean {
    return this.seat.mode === "versus";
  }

  /** Host match state; tools/two-client.mjs ends rounds through it. */
  get vs(): VersusMatch | null {
    return this.run.match;
  }

  /** The party connection; tools/two-client.mjs counts its players. */
  get session(): NetSession | undefined {
    return this.seat.session;
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.demo = params.get("demo") === "1";
    const heroName = this.heroParam(params);
    this.run = newRunState();
    this.room = newRoomState();
    this.seedRun();
    const restartRequested = this.registry.get("restartExpedition") === true;
    this.registry.set("restartExpedition", false);

    const hudBand = this.buildChrome();
    const { party, mode } = this.partyParams(params);
    this.attachTouchControls(hudBand, mode);
    // Touch has no Escape and no M: @repo/embed's cluster carries both. The
    // trailer plays itself and owns its own chrome, so it opts out (main.ts
    // keeps the hub's mute-only cluster off there for the same reason).
    if (!params.has("trailer")) {
      mountTouchHud(true);
    }
    this.controls = new Input(this, this.gamepad);
    // Online: the player spawns on an empty grid so it's always defined; the
    // real room arrives once the host begins the run (host) or the first room
    // snapshot lands (guest).
    const def = party.length > 0 && !this.demo ? null : this.soloRoomDef(params);
    const spawn = def ? def.playerSpawn : { x: BASE_W / 2, y: BASE_H / 2 };
    const player = this.spawnPlayer(HEROES[heroName], def?.grid ?? new Grid(), spawn.x, spawn.y);
    this.seat = newSeatState(heroName, mode, player);
    this.wireCollaborators(restartRequested);
    if (def) {
      this.rooms.build(def);
      this.updateHud();
    } else {
      this.online.beginConnecting(party);
    }

    // ?trailer=1: the shell's black lead-in only exists once the lazily-imported
    // director has landed, so the boot room above — and the room-label banner it
    // fires — would paint for a frame or two first. Hold the scene's own fade
    // plate (depth 100, over the HUD) until the first shot stages; trailer.stage
    // clears it. Nothing else touches fadeRect on this path.
    if (params.has("trailer")) {
      this.chrome.fadeRect.setAlpha(1);
    }

    this.wireSceneEvents(params);
  }

  private heroParam(params: URLSearchParams): HeroName {
    const { data } = this.scene.settings;
    const dataHero = data instanceof Object && "hero" in data ? data.hero : undefined;
    const wanted = params.get("hero") ?? dataHero ?? this.registry.get("hero");
    return HERO_NAMES.find((h) => h === wanted) ?? "axion";
  }

  // A run that adopted a seeded stream (online checkpoint, test seed) would
  // otherwise replay it here.
  private seedRun() {
    const { data } = this.scene.settings;
    const dataSeed = data instanceof Object && "seed" in data ? data.seed : undefined;
    if (Number.isFinite(dataSeed)) {
      reseed(Number(dataSeed));
    } else {
      unseed();
    }
  }

  private partyParams(params: URLSearchParams) {
    const regParty: JsonValue = this.registry.get("party");
    const party = (params.get("party") ?? (isJsonString(regParty) ? regParty : ""))
      .trim()
      .toUpperCase();
    const regMode: JsonValue = this.registry.get("mode");
    const modeStr = params.get("mode") ?? (isJsonString(regMode) ? regMode : "");
    const mode: SeatState["mode"] = party.length > 0 && modeStr === "vs" ? "versus" : "coop";
    return { mode, party };
  }

  // Constructor injection in dependency order; anything cyclic goes through
  // this scene's SceneHooks. Versus resolves shots via Combat's DuelTarget
  // parameter rather than a back-reference.
  private wireCollaborators(restartRequested: boolean) {
    const { run, expedition, room, seat, chrome } = this;
    this.banners = new BannerHud(this, run, this);
    this.lastStand = new LastStand(this, run, seat, this.banners, this);
    this.progress = new RoomProgress(this, run, expedition, room, seat, this.banners, this);
    this.rooms = new RoomBuilder(this, run, expedition, room, seat, this.banners, this.progress);
    this.combat = new Combat(
      this,
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.lastStand,
      this.progress,
      chrome,
      this,
    );
    this.versus = new VersusFlow(
      this,
      run,
      room,
      seat,
      this.banners,
      this.combat,
      chrome,
      this.touch,
      this,
    );
    this.checkpoint = new CheckpointSync(
      this,
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.combat,
      this.rooms,
      this.versus,
      chrome,
      this,
    );
    this.hostNet = new HostNet(
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.lastStand,
      this.versus,
      this.checkpoint,
      this,
    );
    this.guest = new GuestSync(
      this,
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.checkpoint,
      this.combat,
      this.lastStand,
      this.progress,
      this.rooms,
      this.versus,
      this,
    );
    this.online = new OnlineFlow(
      this,
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.checkpoint,
      this.guest,
      this.hostNet,
      this.rooms,
      this.versus,
      chrome,
      this.controls,
      this,
      restartRequested,
    );
    this.trailer = new TrailerStaging(
      this,
      run,
      expedition,
      room,
      seat,
      this.banners,
      this.combat,
      this.lastStand,
      this.rooms,
      chrome,
      this,
    );
    this.banners.mount();
    this.rooms.mount();
  }

  private wireSceneEvents(params: URLSearchParams) {
    sfx.unlock();
    this.input.keyboard?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => {
      sfx.toggleMute();
      syncTouchHud();
      this.banners.show(sfx.muted ? "SOUND OFF" : "SOUND ON", 700, "status");
    });
    // Versus has no death→hub exit (rounds respawn), so ESC leaves the duel.
    if (this.seat.mode === "versus") {
      this.input.keyboard?.on("keydown-ESC", () => this.scene.start("select"));
    }

    // Death → hub: drop the socket and the hub gets its mute-only touch cluster back.
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.controls.destroy();
      this.gamepad.destroy();
      this.seat.session?.destroy();
      if (!params.has("trailer")) {
        mountTouchHud(false);
      }
    });
  }

  // Fade plate and the text HUD. Returns the touch-HUD band height so the
  // action cluster can clear it.
  private buildChrome(): number {
    const fadeRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x05_07_0b)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Edge-anchored HUD clears the notch/home indicator (safe-area insets) and,
    // top-right, the DOM pause/mute cluster.
    const ins = gameInset(this);
    const hudBand = touchHudBand(this);
    const heartsText = this.add
      .text(8 + ins.left, 6 + ins.top, "", {
        color: "#ff4d6d",
        fontFamily: "monospace",
        fontSize: "12px",
      })
      .setScrollFactor(0)
      .setDepth(80);
    const infoText = this.add
      .text(BASE_W - 8 - ins.right, 7 + ins.top + hudBand, "", {
        color: "#8b95a1",
        fontFamily: "monospace",
        fontSize: "9px",
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(80);
    this.expeditionHud = new ExpeditionHud(this, heartsText, infoText);
    // Kill-streak multiplier, top-centre; grows and warms as the streak climbs.
    const comboText = this.add
      .text(BASE_W / 2, 30, "", { color: "#ffd15c", fontFamily: "monospace", fontSize: "14px" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(81)
      .setAlpha(0);
    this.chrome = { comboText, fadeRect, heartsText, infoText };
    return hudBand;
  }

  // Touch controls: floating stick (movement + down-to-drop) on any free
  // touch, fixed action cluster bottom-right, EXIT (versus only) top-right.
  // Mouse is ignored — desktop keeps the keyboard scheme.
  // Positions are game-space px (the adapter's viewport is the FIT game
  // size); insets keep the cluster clear of the home indicator.
  private attachTouchControls(hudBand: number, mode: SeatState["mode"]) {
    this.touch = isCoarse();
    const cluster: FixedButton[] = [
      {
        id: "jump",
        label: "JUMP",
        position: (v) => ({ x: v.width - 30 - v.inset.right, y: v.height - 34 - v.inset.bottom }),
        radius: 21,
      },
      {
        id: "atk",
        label: "ATK",
        position: (v) => ({ x: v.width - 76 - v.inset.right, y: v.height - 26 - v.inset.bottom }),
        radius: 18,
      },
      {
        id: "dash",
        label: "DASH",
        position: (v) => ({ x: v.width - 34 - v.inset.right, y: v.height - 82 - v.inset.bottom }),
        radius: 15,
      },
      {
        id: "sp",
        label: "SP",
        position: (v) => ({ x: v.width - 82 - v.inset.right, y: v.height - 70 - v.inset.bottom }),
        radius: 15,
      },
    ];
    const buttons: ButtonOptions[] = [...cluster];
    if (mode === "versus") {
      buttons.push({
        id: "exit",
        label: "EXIT",
        position: (v) => ({ x: v.width - 24 - v.inset.right, y: 44 + v.inset.top + hudBand }),
        radius: 15,
      });
    }
    this.gamepad = attachVirtualGamepad(this, {
      buttons,
      onButtonDown: (id) => {
        if (id === "exit") {
          this.scene.start("select");
        }
      },
      render: { blendMode: BlendModes.NORMAL, depth: 90 },
      stick: {
        deadZone: 8,
        knobRadius: 14,
        radius: 40,
        // Over a pit, a thumb that reaches for DASH, lands in the gap between
        // two buttons and slides would otherwise read as a full-speed run.
        region: (p, v) => {
          const bounds = clusterBounds(cluster, v);
          return p.x < bounds.left || p.y < bounds.top;
        },
      },
      visible: "coarse",
    });
  }

  private soloRoomDef(params: URLSearchParams): RoomDef {
    const roomParam = parseRoomType(params.get("room") ?? "");
    const def = roomParam ? this.expedition.debugEnter(roomParam) : this.expedition.begin();
    // Dev: ?biome=N previews a deeper biome's palette + roster (debug rooms only).
    const biomeParam = Math.floor(Number(params.get("biome")));
    if (roomParam && Number.isFinite(biomeParam) && biomeParam >= 1) {
      this.expedition.biome = biomeParam;
    }
    return def;
  }

  // Both players leave world-space cues; routine camera motion belongs to me.
  shake(duration: number, intensity: number) {
    if (!REDUCED_MOTION.matches) {
      this.cameras.main.shake(duration, intensity);
    }
  }

  spawnPlayer(hero: HeroDef, grid: Grid, x: number, y: number): Player {
    const pl: Player = new Player(this, grid, x, y, hero, {
      onDash: () => {
        if (pl === this.seat.player) {
          this.shake(60, 0.0025);
        }
        sfx.dash(pl === this.seat.player ? "local" : "routine");
      },
      onHurt: () => {
        if (pl === this.seat.player) {
          this.shake(180, 0.012);
        }
        sfx.hurt(pl === this.seat.player ? "essential" : "routine");
      },
      onJump: () => sfx.jump(pl === this.seat.player ? "local" : "routine"),
      onLand: (impact) => {
        if (pl === this.seat.player) {
          this.shake(80, Math.min(0.003 + impact * 0.00002, 0.008));
        }
        dust(this, pl.x, pl.y);
      },
      onSpecial: (kind) => this.combat.onSpecialFx(kind, pl),
      // No painted attack VFX — the sprite-sheet swing carries the strike. Just
      // feel: a small camera shake + the swing sound.
      onSwing: () => {
        if (pl === this.seat.player) {
          this.shake(50, 0.0015);
        }
        sfx.slash(pl === this.seat.player ? "local" : "routine");
      },
      onWallJump: (side) => {
        wallSmoke(this, pl.x + side * 7, pl.y - 12, side);
        if (pl === this.seat.player) {
          this.shake(40, 0.002);
        }
      },
    });
    return pl;
  }

  // ── input ────────────────────────────────────────────────────────────────
  // This frame's local player input: the guest's sample once online, the demo
  // script on the title loop, else the live controls.
  private localInput(): InputState {
    if (this.seat.controlsPaused) {
      return NEUTRAL_INPUT;
    }
    if (this.seat.session) {
      return this.seat.guestIn;
    }
    return this.sampleInput();
  }

  sampleInput(): InputState {
    return this.demo ? this.demoInput() : this.controls.sample();
  }

  pinScale(): number {
    return this.trailer.pinScale;
  }

  trailerActive(): boolean {
    return this.trailer.active;
  }

  private demoInput(): InputState {
    const cyc = this.demoT % 1.9;
    const jumpHeld = cyc < 0.24;
    const dashWin = cyc > 1.4 && cyc < 1.44;
    const atkWin = (cyc > 0.5 && cyc < 0.54) || (cyc > 0.8 && cyc < 0.84);
    const specWin = cyc > 1.7 && cyc < 1.74;
    const jp = jumpHeld && !this.prevJump;
    const dp = dashWin && !this.prevDash;
    const ap = atkWin && !this.prevAtk;
    const sp = specWin && !this.prevSpecial;
    this.prevJump = jumpHeld;
    this.prevDash = dashWin;
    this.prevAtk = atkWin;
    this.prevSpecial = specWin;
    return {
      attackPressed: ap,
      dashPressed: dp,
      down: false,
      jumpHeld,
      jumpPressed: jp,
      left: false,
      right: true,
      specialPressed: sp,
      up: false,
    };
  }

  // ── frame loop ─────────────────────────────────────────────────────────────
  update(_t: number, delta: number) {
    this.expeditionHud?.setVisible(
      !this.seat.controlsPaused && this.run.state === "active" && !this.trailer.active,
    );
    const dts = Math.min(delta, 100) / 1000;
    this.banners.update(dts * 1000);
    this.demoT += dts;
    this.publishDiag();
    // Once per frame, before any sample(): reconciles lost touches, publishes
    // the justPressed edges the Input merge reads, and redraws the overlay.
    this.gamepad.update();
    // Same contract for the physical controller poll inside Input.
    this.controls.update();

    if (this.seat.session && !this.online.updateSession()) {
      return;
    }

    if (this.run.state === "connecting") {
      this.online.prepareSession();
      return;
    }
    if (this.run.state === "dead") {
      this.updateDead(dts);
      return;
    }
    if (this.run.state === "transition") {
      this.updateTransition(dts);
      return;
    }

    // Guest: predict my own body locally; render everything else from the
    // host's broadcast.
    if (this.seat.role === "guest") {
      this.guest.step(dts);
      return;
    }

    // Host / solo: authoritative fixed-step sim.
    if (this.seat.role === "host") {
      this.hostNet.syncRemotePresence();
    }
    this.bufferAuthorityInputs();
    this.run.acc += dts;
    let steps = 0;
    while (this.run.acc >= STEP && steps < MAX_STEPS) {
      if (this.run.freeze > 0) {
        this.run.freeze -= STEP;
      } else {
        this.simStep(STEP);
      }
      this.run.acc -= STEP;
      steps += 1;
    }

    // Interpolate the render between the last two sim steps by the leftover step
    // fraction, so motion stays smooth when the display refreshes faster than 60Hz.
    const alpha = Math.min(this.run.acc / STEP, 1);
    this.seat.player.render(alpha);
    this.seat.remote?.render(alpha);
    for (const e of this.room.enemies) {
      e.render(alpha);
    }
    this.room.boss?.render(alpha);
    this.lastStand.render();
    this.updateHud();

    if (this.seat.role === "host") {
      this.hostNet.broadcast(dts);
    }
  }

  // Bot-playtest telemetry (sys/diag.ts): mutate the shared object in place.
  private publishDiag() {
    diag.frame += 1;
    diag.score = this.run.score;
    diag.complete = this.run.state === "dead";
    diag.player.x = this.seat.player.x;
    diag.player.y = this.seat.player.y;
    diag.player.speed = Math.hypot(this.seat.player.body.vx, this.seat.player.body.vy);
    diag.entities = this.room.enemies.length + this.room.guest.enemyPuppets.size;
  }

  private updateDead(dts: number) {
    this.run.deadT += dts;
    if (this.seat.role === "host") {
      this.hostNet.broadcast(dts);
    }
    for (const e of this.room.enemies) {
      e.render();
    }
    // Trailer scenes stage their own restart — never bounce to the hub.
    if (this.run.deadT > 2.4 && !this.trailer.active) {
      this.scene.start("select", { recap: this.run.runRecap });
    }
  }

  private updateTransition(dts: number) {
    this.run.transT += dts;
    const half = 0.22;
    this.chrome.fadeRect.setAlpha(
      this.run.transT < half
        ? this.run.transT / half
        : Math.max(0, 1 - (this.run.transT - half) / half),
    );
    if (!this.run.transBuilt && this.run.transT >= half && this.run.pendingOffer) {
      this.rooms.build(this.expedition.choose(this.run.pendingOffer));
      this.updateHud();
      this.run.transBuilt = true;
    }
    if (this.run.transT >= half * 2) {
      this.chrome.fadeRect.setAlpha(0);
      this.run.pendingOffer = null;
      this.run.state = "active";
    }
    this.seat.player.render();
    this.seat.remote?.render();
    for (const e of this.room.enemies) {
      e.render();
    }
    this.room.boss?.render();
    if (this.seat.role === "host") {
      this.hostNet.broadcast(dts);
    }
  }

  // Host / solo: feed this frame's inputs (scripted by the trailer, else local +
  // the guest's wire input) into the bodies, honouring the versus freeze/rematch.
  private bufferAuthorityInputs() {
    const scripted = this.trailer.input ? this.trailer.input() : null;
    const snap = scripted ? scripted.p1 : this.localInput();
    let remoteIn: InputState | null = null;
    if (scripted) {
      remoteIn = scripted.p2;
    } else if (this.seat.remote) {
      remoteIn = this.hostNet.readRemoteInput();
    }
    if (!this.run.match) {
      this.seat.player.buffer(snap);
      if (this.seat.remote && remoteIn) {
        this.seat.remote.buffer(remoteIn);
      }
      return;
    }
    // Match over + hold lapsed: either duelist's attack press restarts it.
    if (this.run.match.canRematch && (snap.attackPressed || (remoteIn?.attackPressed ?? false))) {
      this.run.match.beginMatch();
      this.versus.respawn();
      this.banners.show("REMATCH — ROUND 1", 1100, "critical");
      sfx.door("local");
    }
    // Round intro / match end: bodies hold still (gravity still applies).
    const { frozen } = this.run.match;
    this.seat.player.buffer(frozen ? NEUTRAL_INPUT : snap);
    if (this.seat.remote && remoteIn) {
      this.seat.remote.buffer(frozen ? NEUTRAL_INPUT : remoteIn);
    }
  }

  /** Wrapper pause gates intent, not the partner's online simulation. */
  setControlsPaused(paused: boolean): void {
    if (this.seat.controlsPaused === paused) {
      return;
    }
    this.seat.controlsPaused = paused;
    this.expeditionHud?.setVisible(!paused && this.run.state === "active" && !this.trailer.active);
    this.controls?.reset();
    this.seat?.player.body.clearInput();
    this.seat.guestIn = NEUTRAL_INPUT;
    if (this.seat.session?.live) {
      this.online.sendInput(NEUTRAL_INPUT);
    }
  }

  // ── sim tick (host / solo) ─────────────────────────────────────────────────
  simStep(dt: number) {
    if (this.run.match) {
      this.versus.simStep(dt);
      return;
    }
    if (this.run.combo > 0) {
      this.run.comboT -= dt;
      if (this.run.comboT <= 0) {
        this.combat.breakCombo();
      }
    }
    for (const pl of livePlayers(this.seat)) {
      pl.step(dt);
    }
    for (const e of this.room.enemies) {
      const t = this.combat.nearestPlayer(e.body.x, e.body.y);
      e.body.step(dt, t.x, t.y);
    }
    this.combat.stepBoss(dt);
    this.combat.stepArrows(dt);
    this.combat.stepShots(dt);
    this.combat.stepHazards(dt);
    for (const pl of livePlayers(this.seat)) {
      this.combat.playerOffense(pl);
    }
    this.combat.enemyOffense();
    this.lastStand.step(dt);
    this.progress.stepFeature();
    this.progress.stepMerchant();
    this.combat.cullEnemies(dt);
    this.progress.checkClear();
    this.progress.checkDoors();
  }

  // The shared run is over (solo, or co-op with no last stand left to give).
  playerDie() {
    if (this.run.state === "dead") {
      return;
    }
    this.run.downed = null;
    this.run.downedNet = null;
    this.lastStand.destroyUi();
    this.run.hearts = 0;
    this.run.state = "dead";
    this.run.deadT = 0;
    this.seat.player.sprite.play(`${this.seat.heroName}:death`);
    sfx.die();
    // Push one final hearts=0 snapshot so the guest sees the shared death.
    if (this.seat.role === "host") {
      this.hostNet.broadcast(0, true);
    }
    if (this.trailer.active) {
      // Trailer deaths never touch the real meta/best-score saves; show the
      // shard yield the death WOULD bank (death-as-progress is the beat).
      const would =
        Math.floor(this.run.gold / 4) + this.expedition.depth * 2 + (this.expedition.biome - 1) * 6;
      this.banners.show(`YOU FELL   SCORE ${this.run.score}   +${would} ✦`, 2600, "critical");
      return;
    }
    const earned = bankRun(loadMeta(), this.run.gold, this.expedition.depth, this.expedition.biome);
    const best = recordBestScore(this.run.score);
    this.run.runRecap = {
      bestScore: best,
      biome: this.expedition.biome,
      depth: this.expedition.depth,
      gold: this.run.gold,
      hero: this.seat.heroName,
      kind: "banked",
      score: this.run.score,
      shardsEarned: earned,
    };
    const pb = this.run.score > 0 && this.run.score >= best ? "  ★ NEW BEST" : "";
    this.banners.show(`YOU FELL   SCORE ${this.run.score}${pb}   +${earned} ✦`, 2600, "critical");
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  private offerKind(item: MerchantItem): ExpeditionOffer["kind"] {
    if (item.bought) {
      return "sold";
    }
    return this.run.gold >= item.relic.price ? "affordable" : "unaffordable";
  }

  updateHud() {
    const special =
      this.seat.role === "guest" ? this.room.guest.special : this.seat.player.body.specialReadiness;
    const visible =
      !this.seat.controlsPaused && this.run.state === "active" && !this.trailer.active;
    if (this.seat.mode === "versus") {
      this.versus.updateHud();
      this.expeditionHud?.updateSpecial(this.versus.frozen() ? { kind: "busy" } : special, visible);
      return;
    }
    const guest = this.seat.role === "guest";
    const biome = guest ? this.expedition.biome : this.expedition.biome;
    const depth = guest ? this.expedition.depth : this.expedition.depth;
    const type = guest ? this.expedition.type : this.expedition.type;
    const boss = guest ? this.room.guest.bossPuppet?.net : this.room.boss?.body;
    const bossName = boss && !boss.dead ? bossKind(biome).name : null;
    if (!this.trailer.active) {
      this.layoutHudText(type, bossName !== null);
    }
    this.expeditionHud?.update({
      biome,
      biomeName: biomePalette(biome).name,
      bossAt: this.expedition.bossAt,
      bossName,
      depth,
      gold: this.run.gold,
      hearts: this.run.hearts,
      maxHearts: this.run.maxHearts,
      offer: type === "merchant" ? this.nearestOffer() : null,
      relics: RELICS.filter((r) => this.run.ownedRelics.has(r.id)),
      safeRoom: !this.expedition.isCombat(type),
      score: this.run.score,
      special,
      visible,
    });
  }

  // Banner and streak counter give way to the merchant card / boss plate.
  private layoutHudText(type: RoomType, bossShown: boolean) {
    this.banners.text.setY(type === "merchant" ? 170 : BASE_H / 2 - 20);
    this.banners.text.setVisible(
      !this.expeditionHud?.inspecting || this.banners.active?.kind === "critical",
    );
    this.chrome.comboText.setY(bossShown ? 67 + gameInset(this).top : 42 + gameInset(this).top);
  }

  // The merchant item closest to me, as the HUD's offer card.
  private nearestOffer(): ExpeditionOffer | null {
    let nearest: MerchantItem | undefined;
    for (const item of this.room.merchantItems) {
      if (
        !nearest ||
        Math.abs(item.x - this.seat.player.x) < Math.abs(nearest.x - this.seat.player.x)
      ) {
        nearest = item;
      }
    }
    if (!nearest) {
      return null;
    }
    return {
      desc: nearest.relic.desc,
      kind: this.offerKind(nearest),
      name: nearest.relic.name,
      price: nearest.relic.price,
    };
  }

  // ── trailer entry points (src/trailer/trailer-director.ts) ─────────────────
  // Thin delegators: the director drives the scene through these; the staging
  // itself lives in trailer-staging.ts.
  trailerStage(o: TrailerStageOpts): void {
    this.trailer.stage(o);
  }

  trailerZoom(z: number): void {
    this.trailer.zoom(z);
  }

  trailerSpawnEnemy(name: EnemyName, x: number, y: number, affixId?: string): void {
    this.trailer.spawnEnemy(name, x, y, affixId);
  }

  trailerSetInput(provider: (() => TrailerInputs) | null): void {
    this.trailer.setInput(provider);
  }

  trailerTick(steps: number): void {
    this.trailer.tick(steps);
  }

  trailerFreeze(seconds: number): void {
    this.trailer.freeze(seconds);
  }

  trailerMods(m: Partial<RunMods>): void {
    this.trailer.mods(m);
  }

  trailerBanner(text: string, ms: number): void {
    this.trailer.banner(text, ms);
  }

  trailerWorld(): TrailerWorld {
    return this.trailer.world();
  }
}
