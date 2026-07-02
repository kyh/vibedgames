// Character & animation viewer (?viewer=1). Pick any champion, creep, or the
// boss; browse every clip of its rig, or fire its REAL abilities at a training
// dummy through the actual sim (createWorld/step + WorldView + Fx — the same
// pipeline the game renders through, so cast anims, telegraphs, hit-stop and
// damage numbers are all authentic).
//
// Two subject modes, swapped by the right-panel tab:
//  · ABILITIES — the subject is a real sim hero (max level, cooldowns zeroed
//    every frame). The action buttons are radio-style: the selected ability
//    re-casts on a loop (walking into range each time), BASIC ATTACK keeps
//    auto-attacking, clicking the selected button again deselects → idle.
//    WorldView owns the animations.
//  · ANIMATIONS — the sim hero is removed and a standalone AnimatedCharacter
//    (with the champ's weapons) stands on the stage; any clip plays on click,
//    with loop toggle + live speed, one-shots chaining back into idle.
//
// Loaded via dynamic import (own vite chunk) like the editor; owns its input
// (orbit/zoom/pan camera written directly every frame — View.follow unused).
import * as THREE from "three";
import { CHAMPIONS, type ChampDef } from "../data/champions";
import { SIM_DT, LEVEL_CAP, XP_CURVE } from "../data/config";
import { abilityIcon, attackIcon, champSigil } from "../data/icons";
import { CAMPS } from "../data/map";
import { terrainHeight } from "../data/terrain";
import { castAbility } from "../sim/abilities";
import { dist, norm } from "../sim/math";
import { recomputeStats } from "../sim/stats";
import { ABILITY_KEYS, type AbilityKey, type Unit, type World } from "../sim/types";
import { createWorld, spawnHero, step, syncAbilityRanks } from "../sim/world";
import { Fx } from "../render/fx";
import { AnimatedCharacter, type ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import { WorldView } from "../render/world-view";

// ── stage layout (flat ground, clear of obstacles/camps/spawn guards) ────────
const SUBJECT = { x: 0, y: 16 };
const DUMMY = { x: 7, y: 16 };
const DUMMY_ID = "h-dummy";
const OWNER = "viewer";

// selected-action loop
const CAST_LOOP_MS = 1600; // recast cadence — cast anim (~520ms) + a natural idle beat
const SWING_GAP_S = 0.5; // standalone (creep/boss) swing loop: pause between swings
const SWING_TS = 1.2; // standalone swing playback rate

// camera
const MIN_DIST = 3;
const MAX_DIST = 18;
const MIN_PITCH = 0.06;
const MAX_PITCH = 1.35;
const LOOK_H = 1.2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ── roster ───────────────────────────────────────────────────────────────────
type RosterEntry = {
  id: string;
  label: string;
  sub: string;
  kind: "champ" | "creep";
  model: string;
  weaponR?: string;
  weaponL?: string;
  rig?: "large";
  scale?: number;
  /** basic-attack clip rotation for creeps/boss (played standalone) */
  attackClips: string[];
  champ?: ChampDef;
};

function champEntry(def: ChampDef): RosterEntry {
  const e: RosterEntry = {
    id: def.id,
    label: def.name,
    sub: def.title,
    kind: "champ",
    model: def.model,
    attackClips: [],
    champ: def,
  };
  if (def.weaponR !== undefined) e.weaponR = def.weaponR;
  if (def.weaponL !== undefined) e.weaponL = def.weaponL;
  if (def.rig !== undefined) e.rig = def.rig;
  if (def.scale !== undefined) e.scale = def.scale;
  return e;
}

// Creep/boss look + attack clips mirror world-view's CREEP_VIEW / ATTACK_SETS
// (replicated here so the viewer stays a leaf — no new exports from render).
const CREEPS: RosterEntry[] = [
  { id: "skwarrior", label: "Skeleton Warrior", sub: "camp creep", kind: "creep", model: "Skeleton_Warrior", attackClips: ["Melee_1H_Attack_Chop", "Melee_1H_Attack_Stab"] },
  { id: "skmage", label: "Skeleton Mage", sub: "camp creep", kind: "creep", model: "Skeleton_Mage", weaponR: "Skeleton_Staff", attackClips: ["Ranged_Magic_Shoot"] },
  { id: "skminion", label: "Skeleton Minion", sub: "camp creep", kind: "creep", model: "Skeleton_Minion", attackClips: ["Melee_Unarmed_Attack_Punch_A", "Melee_1H_Attack_Chop"] },
  { id: "skrogue", label: "Skeleton Rogue", sub: "camp creep", kind: "creep", model: "Skeleton_Rogue", weaponR: "Skeleton_Dagger", attackClips: ["Melee_Dualwield_Attack_Stab", "Melee_Dualwield_Attack_Slice"] },
  { id: "frostgolem", label: "Frost Golem", sub: "elite (Rig_Large)", kind: "creep", model: "FrostGolem", weaponR: "FrostGolem_Axe_Large", rig: "large", scale: 1.45, attackClips: ["Melee_2H_Attack", "Melee_2H_Slam", "Melee_Unarmed_Smash"] },
  { id: "boss", label: "Skeleton Golem", sub: "throne boss (Rig_Large)", kind: "creep", model: "Skeleton_Golem", rig: "large", scale: 1.5, attackClips: ["Melee_2H_Slam", "Melee_2H_Attack"] },
];

const ROSTER: RosterEntry[] = [...CHAMPIONS.map(champEntry), ...CREEPS];

function entryById(id: string): RosterEntry | null {
  return ROSTER.find((e) => e.id === id) ?? null;
}

// ── clip catalog grouping ────────────────────────────────────────────────────
const CLIP_GROUPS = ["LOCOMOTION", "MELEE", "RANGED", "EVADE", "REACT", "SKELETON", "MISC"] as const;

function clipGroup(n: string): (typeof CLIP_GROUPS)[number] {
  if (/^(Idle|Walking|Running|Sprint|Crouch|Sit|Lie)/.test(n)) return "LOCOMOTION";
  if (n.startsWith("Melee_")) return "MELEE";
  if (n.startsWith("Ranged_")) return "RANGED";
  if (/^(Dodge|Jump|Roll)/.test(n)) return "EVADE";
  if (/^(Hit|Death|Spawn)/.test(n)) return "REACT";
  if (n.startsWith("Skeletons_")) return "SKELETON";
  return "MISC";
}

// soft radial blob shadow for the standalone subject (mirrors world-view's)
function makeBlobTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.85)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class ViewerScene {
  private world: World;
  private worldView: WorldView;
  private fx: Fx;
  private scene: THREE.Scene;
  private acc = 0;
  private t = 0;

  private selected: RosterEntry;
  private tab: "abilities" | "animations" = "abilities";

  // sim subject + the selected-action loop (radio: one action repeats forever)
  private heroId = "";
  private heroSeq = 0;
  private action: AbilityKey | "attack" | null = "attack";
  private nextCastAt = 0; // world.now (ms) gate for the ability recast loop
  private nextSwingT = 0; // this.t (s) gate for the standalone swing loop
  private castCount = 0; // total casts fired (dev-handle: proves the loop re-fires)

  // standalone subject
  private solo: AnimatedCharacter | null = null;
  private soloEntry: RosterEntry | null = null;
  private soloBlob: THREE.Mesh | null = null;
  private soloChainAt = -1; // this.t (s) when a one-shot chains back to idle
  private activeClip = "";
  private loop = true;
  private speed = 1;
  private attackIdx = 0;

  // camera (spherical orbit) — boot pose: side-on stage view, subject left,
  // dummy right (sim mode weights the focus a third of the way to the dummy)
  private yaw = 0;
  private pitch = 0.3;
  private dist = 10;
  private target = new THREE.Vector3(SUBJECT.x, 0, SUBJECT.y);
  private panX = 0;
  private panZ = 0;
  private orbiting = false;
  private panning = false;
  private lastPX = 0;
  private lastPY = 0;

  // UI refs
  private searchQ = "";
  private panelEl: HTMLElement | null = null;
  private nameEl: HTMLElement | null = null;
  private rosterEl: HTMLElement | null = null;

  constructor(
    private view: View,
    private lib: ModelLibrary,
  ) {
    this.scene = view.scene;
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = 0.008;
    const first = ROSTER[0];
    if (!first) throw new Error("viewer: empty roster");
    this.selected = first;

    // ── the sim under the hood: a real world, muted of everything ambient ──
    this.world = createWorld(0x5eed);
    this.world.matchTime = Number.MAX_SAFE_INTEGER; // no timer end
    this.world.killGoal = Number.MAX_SAFE_INTEGER; // no kill end
    this.world.nextCoinAt = Number.MAX_SAFE_INTEGER; // no boss coins
    this.world.nextDeliveryAt = Number.MAX_SAFE_INTEGER; // no drops
    for (const c of CAMPS) this.world.campRespawnAt[c.id] = Number.MAX_SAFE_INTEGER; // no camps
    this.spawnDummy();

    this.worldView = new WorldView(this.scene, lib);
    this.fx = new Fx(this.scene, view);
    this.fx.localOwnerId = OWNER; // damage numbers for the subject's hits
    this.worldView.fx = this.fx;
  }

  init(): void {
    this.buildUI();
    this.bindInput();
    this.applyMode();
    this.view.refreshShadows();
  }

  // ── sim units ────────────────────────────────────────────────────────────

  /** The training dummy: a real (enemy-team) hero so abilities/statuses land —
   *  sim ability targeting only hits kind "hero". Neutralized every frame. */
  private spawnDummy(): void {
    const d = spawnHero(this.world, {
      id: DUMMY_ID,
      ownerId: "dummy",
      team: "dummy",
      champId: "knight",
      name: "Dummy",
      isBot: false, // tickBots ignores it — it never acts
      slot: 3,
    });
    d.x = DUMMY.x;
    d.y = DUMMY.y;
    d.level = LEVEL_CAP;
    d.xp = XP_CURVE[LEVEL_CAP - 1] ?? 0;
    recomputeStats(d);
    d.hp = d.maxHp;
    d.aimX = -1;
    d.aimY = 0;
    d.facing = Math.PI;
  }

  private hero(): Unit | null {
    return this.heroId ? (this.world.units.get(this.heroId) ?? null) : null;
  }

  private dummy(): Unit | null {
    return this.world.units.get(DUMMY_ID) ?? null;
  }

  private spawnSubjectHero(champId: string): void {
    this.removeHero();
    this.heroSeq += 1;
    this.heroId = `h-view-${this.heroSeq}`; // fresh id → WorldView rebuilds the view
    const u = spawnHero(this.world, {
      id: this.heroId,
      ownerId: OWNER,
      team: OWNER,
      champId,
      name: "Subject",
      isBot: false,
      slot: 0,
    });
    u.x = SUBJECT.x;
    u.y = SUBJECT.y;
    u.level = LEVEL_CAP;
    u.xp = XP_CURVE[LEVEL_CAP - 1] ?? 0;
    syncAbilityRanks(u); // level 12 → Q/W/E rank 4, R rank 3
    recomputeStats(u);
    u.hp = u.maxHp;
    u.aimX = 1;
    u.aimY = 0;
    u.facing = 0;
    this.worldView.localId = this.heroId;
    this.fx.localId = this.heroId;
    this.action = "attack"; // default action on character switch
    this.nextCastAt = 0;
  }

  private removeHero(): void {
    if (this.heroId) this.world.units.delete(this.heroId); // view disposes on next sync
    this.heroId = "";
  }

  // ── standalone subject ───────────────────────────────────────────────────

  private ensureSolo(entry: RosterEntry): void {
    if (this.solo && this.soloEntry === entry) return;
    this.disposeSolo();
    const prefix = entry.rig === "large" ? "Large/" : "";
    const char = new AnimatedCharacter(this.lib, entry.model, prefix);
    const s = entry.scale ?? 1;
    char.root.scale.setScalar(s);
    char.root.position.set(SUBJECT.x, terrainHeight(SUBJECT.x, SUBJECT.y), SUBJECT.y);
    char.root.rotation.y = this.yaw + 0.65; // three-quarter pose toward the camera
    if (entry.weaponR) char.attach(this.weapon(entry.weaponR), "handslot.r");
    if (entry.weaponL) char.attach(this.weapon(entry.weaponL), "handslot.l");
    this.scene.add(char.root);
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 20),
      new THREE.MeshBasicMaterial({ map: makeBlobTexture(), transparent: true, opacity: 0.42, depthWrite: false, color: 0x000000 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.scale.setScalar(s);
    blob.position.set(SUBJECT.x, terrainHeight(SUBJECT.x, SUBJECT.y) + 0.02, SUBJECT.y);
    this.scene.add(blob);
    this.solo = char;
    this.soloEntry = entry;
    this.soloBlob = blob;
    this.soloChainAt = -1;
    char.play("Idle_A", { fade: 0 });
    this.activeClip = "Idle_A";
  }

  /** Weapon instance with its mount correction (mirrors world-view's
   *  WEAPON_MOUNT — the KayKit bow is authored pointing backwards). */
  private weapon(name: string): THREE.Object3D {
    const obj = this.lib.instance(name);
    if (name === "bow") obj.rotation.set(0, Math.PI, 0);
    return obj;
  }

  private disposeSolo(): void {
    if (this.solo) {
      this.scene.remove(this.solo.root);
      this.solo.dispose();
    }
    if (this.soloBlob) {
      this.scene.remove(this.soloBlob);
      this.soloBlob.geometry.dispose();
      if (this.soloBlob.material instanceof THREE.Material) this.soloBlob.material.dispose();
    }
    this.solo = null;
    this.soloEntry = null;
    this.soloBlob = null;
    this.soloChainAt = -1;
    this.activeClip = "";
  }

  // ── mode / selection (also the dev handle window.__vw) ──────────────────

  /** Sim mode = a champion on the ABILITIES tab; everything else is standalone. */
  private get simMode(): boolean {
    return this.selected.kind === "champ" && this.tab === "abilities";
  }

  select(id: string): void {
    const entry = entryById(id);
    if (!entry || entry === this.selected) return;
    this.selected = entry;
    this.action = "attack"; // default selection on character switch
    this.nextSwingT = 0;
    this.applyMode();
  }

  setTab(tab: "abilities" | "animations"): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.applyMode();
  }

  private applyMode(): void {
    if (this.simMode) {
      this.disposeSolo();
      const h = this.hero();
      if (!h || h.champId !== this.selected.id) this.spawnSubjectHero(this.selected.id);
    } else {
      this.removeHero();
      this.ensureSolo(this.selected);
    }
    this.renderRosterActive();
    this.renderPanel();
    if (this.nameEl) this.nameEl.textContent = `${this.selected.label} · ${this.selected.sub}`;
  }

  /** Select an ability as the looping action (radio). Clicking the selected
   *  ability again deselects → idle. The loop walks into range and re-casts. */
  cast(key: AbilityKey): void {
    if (this.selected.kind !== "champ") return;
    if (this.tab !== "abilities") this.setTab("abilities");
    this.action = this.action === key ? null : key;
    this.nextCastAt = 0; // fire immediately
    this.renderPanel();
  }

  /** Select BASIC ATTACK as the looping action (radio; re-click deselects).
   *  Champ: continuous sim auto-attack. Creep/boss: standalone swing loop. */
  attack(): void {
    if (this.selected.kind === "champ" && this.tab !== "abilities") this.setTab("abilities");
    this.action = this.action === "attack" ? null : "attack";
    this.nextSwingT = 0;
    this.renderPanel();
  }

  /** Play a raw clip on the standalone subject (Animations tab). */
  playClip(name: string): void {
    if (this.simMode) this.setTab("animations");
    const char = this.solo;
    if (!char) return;
    const loop = this.loop;
    char.play(name, { loop, timeScale: this.speed, fade: 0.12 });
    this.activeClip = name;
    if (!loop) {
      const d = this.clipDuration(name);
      this.soloChainAt = d > 0 ? this.t + d / Math.max(0.1, this.speed) + 0.05 : -1;
    } else {
      this.soloChainAt = -1;
    }
    this.refreshClipHighlight();
  }

  setLoop(v: boolean): void {
    this.loop = v;
    const el = document.getElementById("vw-loop");
    if (el instanceof HTMLInputElement) el.checked = v;
  }

  setSpeed(v: number): void {
    this.speed = clamp(v, 0.1, 2);
    this.solo?.setTimeScale(this.speed);
    const el = document.getElementById("vw-speed");
    if (el instanceof HTMLInputElement) el.value = String(this.speed);
    const lab = document.getElementById("vw-speed-val");
    if (lab) lab.textContent = `${this.speed.toFixed(2)}×`;
  }

  /** Re-place subject + dummy at their posts. */
  reset(): void {
    const h = this.hero();
    if (h) {
      h.x = SUBJECT.x;
      h.y = SUBJECT.y;
      h.vx = h.vy = h.steerVx = h.steerVy = 0;
      h.dashUntil = 0;
      h.statuses = [];
    }
    const d = this.dummy();
    if (d) {
      d.x = DUMMY.x;
      d.y = DUMMY.y;
      d.statuses = [];
      d.hp = d.maxHp;
    }
    this.panX = 0;
    this.panZ = 0;
  }

  /** Dev-handle snapshot for headless verification. */
  state(): { selected: string; tab: string; simMode: boolean; action: string; castCount: number; activeClip: string; playing: string; heroPos: { x: number; y: number } | null; dummyStatuses: string[] } {
    const h = this.hero();
    const d = this.dummy();
    return {
      selected: this.selected.id,
      tab: this.tab,
      simMode: this.simMode,
      action: this.action ?? "",
      castCount: this.castCount,
      activeClip: this.activeClip,
      playing: this.solo?.playing ?? "",
      heroPos: h ? { x: h.x, y: h.y } : null,
      dummyStatuses: d ? d.statuses.map((s) => s.kind) : [],
    };
  }

  // ── clip catalog ─────────────────────────────────────────────────────────

  /** Display names of every clip the selected character's rig can play. */
  private clipList(): string[] {
    const large = this.selected.rig === "large";
    const out: string[] = [];
    for (const n of this.lib.clipNames()) {
      const isLarge = n.startsWith("Large/");
      if (isLarge !== large) continue;
      out.push(isLarge ? n.slice("Large/".length) : n);
    }
    return out;
  }

  private clipDuration(name: string): number {
    const prefix = this.selected.rig === "large" ? "Large/" : "";
    return this.lib.getClip(prefix + name)?.duration ?? 0;
  }

  // ── frame ────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.t += dt;

    // subject intent (pre-step, once per frame — persists across sub-steps)
    if (this.simMode) this.driveSubject();
    else this.driveSoloSwing();

    // fixed-step the sim (dummy idles even in animations mode)
    this.acc += dt;
    let n = 0;
    while (this.acc >= SIM_DT && n < 5) {
      step(this.world);
      this.acc -= SIM_DT;
      n++;
    }
    this.neutralizeDummy(dt);

    // standalone subject: advance + chain one-shots back into idle
    const solo = this.solo;
    if (solo) {
      solo.update(dt);
      if (this.soloChainAt > 0 && this.t >= this.soloChainAt) {
        this.soloChainAt = -1;
        solo.play("Idle_A", { loop: true, timeScale: this.speed, fade: 0.25 });
        this.activeClip = "Idle_A";
        this.refreshClipHighlight();
      }
    }

    // render pipeline (mirror game-scene: fx first — it may arm a hit-stop)
    this.fx.update(this.world, dt);
    const rdt = dt * this.fx.scaleNow();
    this.worldView.sync(this.world, rdt);
    this.updateCamera(dt);
    this.view.render();
  }

  /** Per-frame hero intent: face the dummy, keep every cooldown at zero, and
   *  run the selected-action loop — walk into range and re-cast/attack forever
   *  (idling naturally between recasts). */
  private driveSubject(): void {
    const h = this.hero();
    const d = this.dummy();
    if (!h || !d) return;
    for (const key of ABILITY_KEYS) h.abilities[key].readyAt = 0; // always ready
    h.hp = h.maxHp;
    const to = norm(d.x - h.x, d.y - h.y);
    const dd = dist(h, d);
    if (this.world.now >= h.dashUntil && (to.x !== 0 || to.y !== 0)) {
      h.aimX = to.x;
      h.aimY = to.y;
    }
    h.moveX = 0;
    h.moveY = 0;
    h.attackHeld = false;

    const act = this.action;
    if (act === "attack") {
      // continuous auto-attack: close in, then hold the trigger
      const reach = h.attackRange + d.radius - 0.2;
      if (dd > reach) {
        h.moveX = to.x;
        h.moveY = to.y;
      } else {
        h.attackHeld = true;
      }
    } else if (act) {
      const def = this.selected.champ?.abilities[act];
      if (def && this.world.now >= this.nextCastAt) {
        // walk into range first: self-casts need the dummy inside their radius,
        // targeted casts their castRange (with a safety margin)
        const needed = def.targeting === "self" ? 3.0 : Math.max(1.4, def.castRange - 0.8);
        if (dd > needed) {
          h.moveX = to.x;
          h.moveY = to.y;
        } else if (castAbility(this.world, h, act, { point: { x: d.x, y: d.y }, dir: to })) {
          this.castCount += 1;
          this.nextCastAt = this.world.now + CAST_LOOP_MS; // re-cast after the beat
        }
      }
    }
  }

  /** Standalone (creep/boss) BASIC ATTACK loop: swing → idle beat → swing. */
  private driveSoloSwing(): void {
    const solo = this.solo;
    if (!solo || this.selected.kind !== "creep") return;
    if (this.tab !== "abilities" || this.action !== "attack") return;
    if (this.t < this.nextSwingT) return;
    const clips = this.selected.attackClips;
    const clip = clips[this.attackIdx++ % Math.max(1, clips.length)];
    if (!clip) return;
    solo.play(clip, { loop: false, timeScale: SWING_TS, fade: 0.1 });
    this.activeClip = clip;
    const dur = this.clipDuration(clip) / SWING_TS;
    this.soloChainAt = this.t + dur + 0.05;
    this.nextSwingT = this.t + dur + SWING_GAP_S;
  }

  /** The dummy soaks everything but never dies, acts, or wanders off. */
  private neutralizeDummy(dt: number): void {
    const d = this.dummy();
    if (!d) return;
    if (!d.alive) {
      d.alive = true;
      d.respawnAt = 0;
      d.statuses = [];
    }
    d.hp = d.maxHp;
    d.attackHeld = false;
    d.moveX = 0;
    d.moveY = 0;
    // spring back to the post after knockbacks/pulls (gentle, so hits still read)
    const k = Math.min(1, 1.6 * dt);
    d.x += (DUMMY.x - d.x) * k;
    d.y += (DUMMY.y - d.y) * k;
    const h = this.hero();
    if (h) {
      const to = norm(h.x - d.x, h.y - d.y);
      if (to.x !== 0 || to.y !== 0) {
        d.aimX = to.x;
        d.aimY = to.y;
      }
    }
  }

  // ── camera ───────────────────────────────────────────────────────────────

  private updateCamera(dt: number): void {
    const h = this.hero();
    let sx = SUBJECT.x;
    let sy = SUBJECT.y;
    if (this.simMode && h) {
      // keep both actors framed: focus midway between subject and dummy
      const d = this.dummy();
      sx = h.x;
      sy = h.y;
      if (d) {
        sx += (d.x - h.x) * 0.5;
        sy += (d.y - h.y) * 0.5;
      }
    }
    const gx = sx + this.panX;
    const gz = sy + this.panZ;
    const goal = new THREE.Vector3(gx, terrainHeight(gx, gz), gz);
    this.target.lerp(goal, Math.min(1, 8 * dt));

    const cp = Math.cos(this.pitch);
    const cam = this.view.camera;
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist + 0.4,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    cam.lookAt(this.target.x, this.target.y + LOOK_H, this.target.z);
  }

  // ── input ────────────────────────────────────────────────────────────────

  private bindInput(): void {
    const el = this.view.renderer.domElement;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      if (e.button === 0) this.orbiting = true;
      else if (e.button === 2 || e.button === 1) this.panning = true;
      else return;
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      const dx = e.clientX - this.lastPX;
      const dy = e.clientY - this.lastPY;
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
      if (this.orbiting) {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
      } else if (this.panning) {
        const k = this.dist * 0.0016;
        const rx = Math.cos(this.yaw);
        const rz = -Math.sin(this.yaw);
        this.panX = clamp(this.panX - (dx * rx + dy * -rz) * k, -8, 8);
        this.panZ = clamp(this.panZ - (dx * rz + dy * rx) * k, -8, 8);
      }
    });
    el.addEventListener("pointerup", (e) => {
      this.orbiting = false;
      this.panning = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.0012), MIN_DIST, MAX_DIST);
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if (document.activeElement instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "q" || k === "w" || k === "e" || k === "r") {
        if (this.selected.kind === "champ") this.cast(k.toUpperCase() === "Q" ? "Q" : k.toUpperCase() === "W" ? "W" : k.toUpperCase() === "E" ? "E" : "R");
      } else if (k === "a") {
        this.attack();
      }
    });
  }

  // ── DOM UI ───────────────────────────────────────────────────────────────

  private buildUI(): void {
    injectStyle();
    const ui = document.createElement("div");
    ui.id = "ba-viewer";
    const rosterButtons = ROSTER.map((e) => {
      const icon = e.kind === "champ" ? `<img src="${champSigil(e.id)}" alt="">` : `<span class="vwr-dot"></span>`;
      return `<button class="vwr" data-id="${e.id}">${icon}<span class="vwr-txt"><b>${e.label}</b><i>${e.sub}</i></span></button>`;
    }).join("");
    ui.innerHTML = `
      <div class="vw-top">
        <span class="vw-logo">CHARACTER VIEWER</span>
        <span class="vw-name" id="vw-name"></span>
        <button id="vw-reset">RESET</button>
        <button id="vw-editor">MAP EDITOR</button>
        <button id="vw-lobby">LOBBY</button>
      </div>
      <div class="vw-roster" id="vw-roster">
        <div class="vw-roster-h">CHAMPIONS</div>
        ${rosterButtons}
      </div>
      <div class="vw-panel">
        <div class="vw-tabs">
          <button class="vwt" id="vw-tab-abilities" data-tab="abilities">ABILITIES</button>
          <button class="vwt" id="vw-tab-animations" data-tab="animations">ANIMATIONS</button>
        </div>
        <div class="vw-body" id="vw-body"></div>
      </div>
      <div class="vw-help">LMB drag orbit · wheel zoom · RMB pan · Q/W/E/R cast · A attack</div>`;
    document.body.appendChild(ui);
    this.panelEl = document.getElementById("vw-body");
    this.nameEl = document.getElementById("vw-name");
    this.rosterEl = document.getElementById("vw-roster");

    // creep divider — insert before the first creep button
    const firstCreep = ui.querySelector(`.vwr[data-id="${CREEPS[0]?.id ?? ""}"]`);
    if (firstCreep) {
      const h = document.createElement("div");
      h.className = "vw-roster-h";
      h.textContent = "ENEMIES";
      firstCreep.before(h);
    }

    ui.querySelectorAll<HTMLButtonElement>(".vwr").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset["id"];
        if (id) this.select(id);
      });
    });
    ui.querySelectorAll<HTMLButtonElement>(".vwt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset["tab"];
        if (tab === "abilities" || tab === "animations") this.setTab(tab);
      });
    });
    document.getElementById("vw-reset")?.addEventListener("click", () => this.reset());
    document.getElementById("vw-editor")?.addEventListener("click", () => {
      location.href = `${location.pathname}?editor=1`;
    });
    document.getElementById("vw-lobby")?.addEventListener("click", () => {
      location.href = location.pathname;
    });
  }

  private renderRosterActive(): void {
    this.rosterEl?.querySelectorAll<HTMLButtonElement>(".vwr").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset["id"] === this.selected.id);
    });
    document.getElementById("vw-tab-abilities")?.classList.toggle("on", this.tab === "abilities");
    document.getElementById("vw-tab-animations")?.classList.toggle("on", this.tab === "animations");
  }

  private renderPanel(): void {
    const box = this.panelEl;
    if (!box) return;
    this.renderRosterActive();
    if (this.tab === "abilities") this.renderAbilities(box);
    else this.renderClips(box);
  }

  private renderAbilities(box: HTMLElement): void {
    const def = this.selected.champ;
    const atkOn = this.action === "attack";
    if (!def) {
      box.innerHTML = `
        <div class="vw-sect">BASIC ATTACK</div>
        <button class="vwa ${atkOn ? "on" : ""}" id="vw-atk">
          <img src="${attackIcon("melee")}" alt="">
          <span class="vwa-key">A</span>
          <span class="vwa-txt"><b>Basic Attack ${atkOn ? "· LOOPING" : ""}</b><i>Swings on repeat. Click again to stop.</i></span>
        </button>
        <div class="vw-note">Enemies have no abilities — browse their full rig on the ANIMATIONS tab.</div>`;
      document.getElementById("vw-atk")?.addEventListener("click", () => this.attack());
      return;
    }
    const abilityRows = ABILITY_KEYS.map((key) => {
      const a = def.abilities[key];
      const on = this.action === key;
      return `
        <button class="vwa ${on ? "on" : ""}" data-key="${key}" title="${a.desc}">
          <img src="${abilityIcon(def.id, key)}" alt="">
          <span class="vwa-key">${key}</span>
          <span class="vwa-txt"><b>${a.name}${a.isUltimate ? " ★" : ""}${on ? " · LOOPING" : ""}</b><i>${a.desc}</i></span>
        </button>`;
    }).join("");
    box.innerHTML = `
      <div class="vw-sect">BASIC ATTACK</div>
      <button class="vwa ${atkOn ? "on" : ""}" id="vw-atk">
        <img src="${attackIcon(def.attackKind)}" alt="">
        <span class="vwa-key">A</span>
        <span class="vwa-txt"><b>Basic Attack ${atkOn ? "· LOOPING" : ""}</b><i>Walks into range and swings at the dummy.</i></span>
      </button>
      <div class="vw-sect">ABILITIES <span class="vw-dim">(max rank · no cooldowns)</span></div>
      ${abilityRows}
      <div class="vw-note">Pick an action — it repeats through the real sim (walk into range, face the dummy, fire). Click the selected action again to idle.</div>`;
    document.getElementById("vw-atk")?.addEventListener("click", () => this.attack());
    box.querySelectorAll<HTMLButtonElement>(".vwa[data-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset["key"];
        if (key === "Q" || key === "W" || key === "E" || key === "R") this.cast(key);
      });
    });
  }

  private renderClips(box: HTMLElement): void {
    const q = this.searchQ.trim().toLowerCase();
    const grouped = new Map<string, string[]>();
    for (const name of this.clipList()) {
      if (q && !name.toLowerCase().includes(q)) continue;
      const g = clipGroup(name);
      const arr = grouped.get(g);
      if (arr) arr.push(name);
      else grouped.set(g, [name]);
    }
    const sections = CLIP_GROUPS.filter((g) => grouped.has(g))
      .map((g) => {
        const rows = (grouped.get(g) ?? [])
          .map((n) => `<button class="vwc ${n === this.activeClip ? "on" : ""}" data-clip="${n}">${n}<span>${this.clipDuration(n).toFixed(2)}s</span></button>`)
          .join("");
        return `<div class="vw-sect">${g}</div>${rows}`;
      })
      .join("");
    box.innerHTML = `
      <input id="vw-search" placeholder="search clips…" value="${this.searchQ}">
      <div class="vw-ctl">
        <label class="vw-chk"><input type="checkbox" id="vw-loop" ${this.loop ? "checked" : ""}>loop</label>
        <input type="range" id="vw-speed" min="0.1" max="2" step="0.05" value="${this.speed}">
        <span id="vw-speed-val">${this.speed.toFixed(2)}×</span>
      </div>
      <div class="vw-clips" id="vw-clips">${sections}</div>`;
    const search = document.getElementById("vw-search");
    if (search instanceof HTMLInputElement) {
      search.addEventListener("input", () => {
        this.searchQ = search.value;
        const at = search.selectionStart;
        this.renderClips(box);
        const again = document.getElementById("vw-search");
        if (again instanceof HTMLInputElement) {
          again.focus();
          if (at !== null) again.setSelectionRange(at, at);
        }
      });
    }
    const loopEl = document.getElementById("vw-loop");
    if (loopEl instanceof HTMLInputElement) loopEl.addEventListener("change", () => this.setLoop(loopEl.checked));
    const speedEl = document.getElementById("vw-speed");
    if (speedEl instanceof HTMLInputElement) speedEl.addEventListener("input", () => this.setSpeed(Number.parseFloat(speedEl.value)));
    box.querySelectorAll<HTMLButtonElement>(".vwc").forEach((btn) => {
      btn.addEventListener("click", () => {
        const clip = btn.dataset["clip"];
        if (clip) this.playClip(clip);
      });
    });
  }

  private refreshClipHighlight(): void {
    document.querySelectorAll<HTMLButtonElement>(".vwc").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset["clip"] === this.activeClip);
    });
  }
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
#ba-viewer{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:ui-monospace,monospace;color:#fff}
#ba-viewer button{pointer-events:auto;cursor:pointer;font:700 11px ui-monospace,monospace;color:#fff;background:rgba(30,38,60,.9);border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:6px 10px}
#ba-viewer button:hover{border-color:#ffd24a;color:#ffd24a}
#ba-viewer input{pointer-events:auto;background:rgba(10,14,24,.9);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font:600 11px ui-monospace,monospace;padding:5px 7px}
.vw-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(#080a12ee,#080a1200)}
.vw-logo{font:900 italic 16px system-ui,sans-serif;letter-spacing:-1px;color:#ffd24a;margin-right:6px}
.vw-name{font:700 12px ui-monospace,monospace;color:#9fd0ff;margin-right:auto}
.vw-roster{position:absolute;top:46px;left:10px;bottom:44px;width:206px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;background:rgba(8,10,18,.82);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
.vw-roster-h{font:800 10px ui-monospace,monospace;letter-spacing:1px;opacity:.55;padding:6px 2px 2px}
.vwr{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:5px 8px}
.vwr img{width:26px;height:26px;border-radius:5px;flex:none;background:#0a0e18}
.vwr-dot{width:26px;height:26px;border-radius:5px;flex:none;background:radial-gradient(circle at 40% 35%,#cfd8e0 0%,#5a6474 55%,#1a2030 100%)}
.vwr-txt{display:flex;flex-direction:column;min-width:0}
.vwr-txt b{font-size:11px}
.vwr-txt i{font-style:normal;font-size:9px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vwr.on{border-color:#ffd24a;background:rgba(64,54,20,.9)}
.vw-panel{position:absolute;top:46px;right:10px;bottom:44px;width:280px;display:flex;flex-direction:column;gap:6px;background:rgba(8,10,18,.85);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
.vw-tabs{display:flex;gap:4px}
.vwt{flex:1}
.vwt.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
.vw-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:0}
.vw-sect{font:800 10px ui-monospace,monospace;letter-spacing:1px;opacity:.55;padding:7px 2px 2px}
.vw-dim{opacity:.6;font-weight:600;letter-spacing:0}
.vwa{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:6px 8px}
.vwa img{width:34px;height:34px;border-radius:6px;flex:none;background:#0a0e18}
.vwa-key{font:900 12px ui-monospace,monospace;color:#ffd24a;width:14px;flex:none;text-align:center}
.vwa-txt{display:flex;flex-direction:column;min-width:0}
.vwa-txt b{font-size:11px}
.vwa-txt i{font-style:normal;font-size:9px;opacity:.65;line-height:1.25;white-space:normal}
.vwa.on{border-color:#7dffb0;background:rgba(20,52,34,.9)}
.vw-note{font:600 9px ui-monospace,monospace;opacity:.45;padding:8px 2px;line-height:1.4}
.vw-ctl{display:flex;align-items:center;gap:8px;padding:2px 0}
.vw-chk{display:flex;align-items:center;gap:4px;font:600 11px ui-monospace,monospace}
#vw-speed{flex:1;padding:0}
#vw-speed-val{font:700 10px ui-monospace,monospace;opacity:.8;width:38px;text-align:right}
.vw-clips{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;min-height:0}
.vwc{display:flex;justify-content:space-between;gap:6px;text-align:left;background:rgba(20,26,42,.85);border-radius:5px;padding:4px 8px;font-weight:600}
.vwc span{opacity:.5;font-weight:600}
.vwc.on{border-color:#7dffb0;color:#7dffb0;background:rgba(20,52,34,.9)}
.vw-help{position:absolute;left:0;right:0;bottom:0;text-align:center;padding:8px;font:600 11px ui-monospace,monospace;opacity:.55;background:linear-gradient(#080a1200,#080a12dd)}
`;
  document.head.appendChild(s);
}
