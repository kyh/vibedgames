// DOM HUD: floating nameplates + HP bars, ability tiles (icons + radial
// cooldown sweeps + rank pips), item belt + shop with icon chips, vitals
// (HP gradient + damage ghost + XP bar + level badge), buff/debuff row,
// reticle + hit-direction ring, kill feed with champ sigils, objective
// banner, minimap, onboarding surfaces (intro countdown, goal banner, hint
// slot, death screen, end card), edge arrows, Tab scoreboard.
// Reads the world each frame; never mutates the sim. Zero WebGL draw calls;
// every per-frame style write is change-gated against a cached last value.
import { isOfflineRequested } from "@repo/embed";
import { CHAMP_BY_ID, valAt } from "../data/champions";
import { abilityIcon, attackIcon, champSigil, iconUrl, statusIcon } from "../data/icons";
import { ITEMS, ITEM_BY_ID, MAX_ITEMS, type ItemDef } from "../data/items";
import { KILL_GOAL_FFA, LEVEL_CAP, XP_CURVE, respawnTime } from "../data/config";
import { ARENA, HEX_R, OBSTACLES } from "../data/map";
import { ALL_ABILITY_KEYS, type AbilityKey, type Unit, type World } from "../sim/types";
import type { Audio } from "./audio";
import type { Fx } from "./fx";
import { LOCAL_COLOR, teamColor } from "./palette";
import type { View } from "./view";
import { abilityReadiness, readablePlates } from "./hud-readability";
import type { PlateAnchor, PlateCandidate, ScreenBox } from "./hud-readability";
import { coinObjective, deliveryObjective } from "./objective-state";
import { terrainHeight } from "../data/terrain";

// Q/W/E/R map to number keys 1-4; DASH/JUMP are the flat util pair (Shift/Space).
const KEYCAP = {
  Q: "1",
  W: "2",
  E: "3",
  R: "4",
  DASH: "⇧",
  JUMP: "␣",
} satisfies Record<AbilityKey, string>;
/** The flat, always-unlocked mobility pair — no rank pips, no level lock. */
const UTIL_KEYS = new Set<AbilityKey>(["DASH", "JUMP"]);

/** Status kinds rendered with a red (hostile) border in the buff row. */
const DEBUFF_KINDS = new Set(["stun", "root", "slow", "dot", "damageAmp", "hex"]);

/** Death-screen tips, rotated by death count (result-05 B5, verbatim). */
const TIPS: string[] = [
  "Dashing grants brief invulnerability",
  "Buy items while standing at base",
  "The throne pays bonus gold",
  "The leader carries a 650g bounty",
  "Grab coins where the golem throws",
  "Green pads give items, or gold when your belt is full",
  "Defeat camp guards for gold",
  "Hopping dodges skillshots",
  "Heal fast inside your base",
  "Kill streaks pay extra gold",
];

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

/** Player names cross the room boundary; render them as text in HUD markup. */
function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type MatchActions =
  | { kind: "offline" }
  | { kind: "online"; canRematch: () => boolean; rematch: () => void };

function sealKitActivation(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

export type ShopCallbacks = {
  buy: (itemId: string) => void;
  canShop: () => boolean;
};

type AbilityEl = {
  wrap: HTMLDivElement;
  img: HTMLImageElement;
  cdText: HTMLDivElement;
  pips: HTMLDivElement;
  lastCd: number;
  lastRank: number;
  wasOnCd: boolean;
  lastText: string;
};

type ItemSocket = {
  chip: HTMLDivElement;
  img: HTMLImageElement;
  cd: HTMLDivElement;
  lastPct: number;
  lastText: string;
  lastRdy: boolean;
};

type BuffEl = { ring: HTMLElement; sec: HTMLElement; lastT: number; lastSec: string };

type Arrow = { el: HTMLDivElement; lastTf: string; on: boolean };

type ToastKind = "leader" | "delivery" | "streak" | "sudden" | "matchend" | "notice";
const TOAST_STYLE = {
  leader: { priority: 2, life: 3600 },
  delivery: { priority: 1, life: 2400 },
  streak: { priority: 0, life: 2400 },
  sudden: { priority: 3, life: 3600 },
  matchend: { priority: 3, life: 2400 },
  notice: { priority: 0, life: 2400 },
} satisfies Record<ToastKind, { priority: number; life: number }>;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const TOAST_MAX_AGE = 6000;
type Toast = { text: string; kind: ToastKind; receivedAt: number };
type VisibleToast = { notice: Toast; el: HTMLElement; until: number };
type FeedRow = { el: HTMLElement; until: number };
type ConfettiStage = { at: number; x: number; y: number; color: number };

/** Network notification kinds remain strings. Unknown kinds get neutral styling,
 * never inferred objective priority from their human-readable text. */
function toastKind(kind: string): ToastKind {
  switch (kind) {
    case "leader":
    case "delivery":
    case "streak":
    case "sudden":
    case "matchend":
      return kind;
    default:
      return "notice";
  }
}

export class Hud {
  private root: HTMLElement;
  private plates = new Map<
    string,
    { wrap: HTMLDivElement; fill: HTMLDivElement; name: HTMLDivElement }
  >();
  private plateAnchors: ((id: string) => PlateAnchor | null) | null = null;
  private plateKeepOut: ScreenBox[] = [];
  private plateKeepOutAt = 0;
  private kitButton: HTMLButtonElement | null = null;
  private kitAction: (() => void) | null = null;
  private coinState: ReturnType<typeof coinObjective> | null = null;
  private deliveryState: ReturnType<typeof deliveryObjective> | null = null;
  private timerEl!: HTMLElement;
  private goalEl!: HTMLElement;
  private objCoinEl!: HTMLElement;
  private objDropEl!: HTMLElement;
  private boardEl!: HTMLElement;
  private feedEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private hpFill!: HTMLElement;
  private hpGhostEl!: HTMLElement;
  private hpTicksEl!: HTMLElement;
  private hpText!: HTMLElement;
  private xpFill!: HTMLElement;
  private lvlBadge!: HTMLElement;
  private lvlEl!: HTMLElement;
  private goldEl!: HTMLElement;
  private buffsEl!: HTMLElement;
  private abilityEls = new Map<AbilityKey, AbilityEl>();
  private respawnEl!: HTMLElement;
  private respawnSlain!: HTMLElement;
  private respawnRing!: HTMLElement;
  private respawnTimer!: HTMLElement;
  private respawnTip!: HTMLElement;
  private itemsEl!: HTMLElement;
  private itemSockets: ItemSocket[] = [];
  private itemTaps: number[] = []; // belt-chip taps → item-use slots (touch path)
  private itemSig = "";
  private minimap!: HTMLCanvasElement;
  private mmCtx!: CanvasRenderingContext2D;
  private shopEl!: HTMLElement;
  private shopOpen = false;
  private endEl!: HTMLElement;
  private shownEnd = false;
  private goalBanner!: HTMLElement;
  private hintEl!: HTMLElement;
  private introEl!: HTMLElement;
  private reticleEl!: HTMLElement;
  private hitDirEl!: HTMLElement;
  private menuBtn!: HTMLButtonElement;
  private arrowCoin!: Arrow;
  private arrowDelivery!: Arrow;
  private lowHpEl: HTMLDivElement;
  private lowHpEl2: HTMLDivElement;
  private readonly remeasureTopBand = (): void => {
    this.plateKeepOutAt = 0;
  };

  /** Set true by the scene for online matches — hides the HEROES button. */
  online = false;

  // ── change-gate caches ──
  private champBound = "";
  private lastReadySoundAt = 0;
  private hpGhost = 1;
  private lastNow = 0;
  private lastLevel = 0;
  private lastMaxHp = 0;
  private lastHpStep = -1;
  private lastGhostStep = -1;
  private lastXpStep = -1;
  private lastHpTextStr = "";
  private lastHpTier = "";
  private lastGoldStr = "";
  private lastTimerStr = "";
  private lastGoalStr = "";
  private lastObjCoin = "";
  private lastObjDrop = "";
  private buffSeen = new Map<string, { seenAt: number; until: number }>();
  private buffEls = new Map<string, BuffEl>();
  private buffSig = "";
  private buffScratch: { kind: string; until: number }[] = [];
  private boardSig = "";
  private boardForced = false;
  private boardTapped = false; // timer-tap latch — the touch Tab
  private lastAttackSeen = 0;
  private fireUntil = 0;
  private hitFlashUntil = 0;
  private hitFlashCrit = false;
  private reticleVisible = false;
  private lastHitSeen = 0;
  private hitDirUntil = 0;
  private lastHitDirDeg = 1e9;
  private lastHitDirOp = -1;
  private respawnShown = false;
  private respawnFor = 0;
  private lastRespawnText = "";
  private lastRespawnPct = -1;
  private lastRespawnCeil = -1;
  private introText = "";
  private hintText = "";
  private lastBannerOp = "";
  private menuBtnHidden = false;
  private bestStreak = 0;
  private lastMe: Unit | null = null;
  private lastLowOp = -1;
  private lastLowOp2 = -1;
  private hbPhase = -1;
  private disposed = false;
  private presentationPaused = false;
  private presentationHidden = document.hidden;
  private presentationNow = 0;
  private feedRows: FeedRow[] = [];
  private visibleToasts: VisibleToast[] = [];
  private pendingToasts: Toast[] = [];
  private confetti: ConfettiStage[] = [];
  private sawSuddenDeath = false;
  private ownedElements: Element[] = [];
  private ownedStyle: HTMLStyleElement | null = null;
  private readonly onVisibilityChange = (): void => {
    if (this.disposed) return;
    this.presentationHidden = document.hidden;
    this.clearPresentation();
    this.dropIncomingPresentation();
    this.showHint("");
    this.showIntro("");
  };
  private readonly onMuteKey = (e: KeyboardEvent): void => {
    if (e.code !== "KeyM" || e.repeat || this.disposed) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    this.sfx.setMuted(!this.sfx.isMuted);
  };

  constructor(
    private view: View,
    private fx: Fx,
    private shop: ShopCallbacks,
    private matchActions: MatchActions = { kind: "offline" },
  ) {
    this.root = document.getElementById("hud")!;
    this.injectStyle();
    this.build();
    this.root.classList.remove("ba-ended");
    this.ownedElements = [...this.root.children];
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    // persistent low-HP danger vignette (two reused nodes; opacity only).
    // Layer 1 = radial closing in from the corners, layer 2 = inset ring that
    // pulses opposite-phase for a "walls closing" read.
    this.lowHpEl = document.createElement("div");
    this.lowHpEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:7;opacity:0;transition:opacity .15s;" +
      "background:radial-gradient(ellipse at center, transparent 45%, rgba(190,20,20,0.85) 130%)";
    document.body.appendChild(this.lowHpEl);
    this.lowHpEl2 = document.createElement("div");
    this.lowHpEl2.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:7;opacity:0;transition:opacity .15s;" +
      "box-shadow:inset 0 0 90px rgba(190,20,20,.55)";
    document.body.appendChild(this.lowHpEl2);
  }

  private get presentationBlocked(): boolean {
    return this.presentationPaused || this.presentationHidden;
  }

  /** Shared Audio instance (owned by Fx) for the UI sound set. */
  private get sfx(): Audio {
    return this.fx.audio;
  }

  setPlateAnchors(read: (id: string) => PlateAnchor | null): void {
    if (!this.disposed) this.plateAnchors = read;
  }

  setKitAction(open: () => void): void {
    if (this.disposed) return;
    this.kitAction = open;
    if (this.kitButton) this.kitButton.hidden = false;
  }

  // ── markup ──
  private build(): void {
    this.root.innerHTML = `
      <div id="ba-plates"></div>
      <div id="ba-top">
        <div id="ba-timer">8:00</div>
        <div id="ba-goal"></div>
        <div id="ba-objective"><span class="coin"></span><span class="drop"></span></div>
      </div>
      <div id="ba-board"></div>
      <div id="ba-feed"></div>
      <button id="ba-menu-btn">HEROES ▸</button>
      <button id="ba-kit-btn" type="button" hidden>YOUR KIT</button>
      <div id="ba-toasts"></div>
      <div id="ba-bottom">
        <div id="ba-left">
        <div id="ba-hint"></div>
        <div id="ba-buffs"></div>
        <div id="ba-vitals">
          <div id="ba-vrow">
            <div id="ba-lvlbadge"><span id="ba-lvl">1</span></div>
            <div class="ba-bar hp"><div id="ba-hpghost"></div><div id="ba-hpfill" class="hi"></div><div id="ba-ticks"></div><span id="ba-hptext"></span></div>
          </div>
          <div class="ba-bar xp"><div id="ba-xpfill"></div></div>
        </div>
        <div id="ba-items"></div>
        <div id="ba-meta"><span id="ba-gold">0</span></div>
        </div>
        <div id="ba-abilities"></div>
      </div>
      <div id="ba-goal-banner"><b>REACH THE THRONE</b> · first to ${KILL_GOAL_FFA} kills</div>
      <div id="ba-intro"></div>
      <div id="ba-arrow-coin" class="ba-arrow">◆</div>
      <div id="ba-arrow-delivery" class="ba-arrow">▲</div>
      <div id="ba-reticle"><i></i><i></i><i></i><i></i><b></b></div>
      <div id="ba-hitdir"></div>
      <div id="ba-respawn" hidden>
        <div class="ba-rtitle">YOU DIED</div>
        <div class="ba-rslain"></div>
        <div class="ba-rwrap"><div class="ba-rring"></div><div class="ba-rtimer"></div></div>
        <div class="ba-rtip"></div>
      </div>
      <canvas id="ba-minimap" width="150" height="132"></canvas>
      <div id="ba-shop" hidden></div>
      <div id="ba-end" hidden></div>`;

    this.timerEl = byId("ba-timer");
    this.goalEl = byId("ba-goal");
    window.addEventListener("resize", this.remeasureTopBand);
    const obj = byId("ba-objective");
    this.objCoinEl = obj.children[0] instanceof HTMLElement ? obj.children[0] : obj;
    this.objDropEl = obj.children[1] instanceof HTMLElement ? obj.children[1] : obj;
    this.boardEl = byId("ba-board");
    this.feedEl = byId("ba-feed");
    this.toastEl = byId("ba-toasts");
    this.hpFill = byId("ba-hpfill");
    this.hpGhostEl = byId("ba-hpghost");
    this.hpTicksEl = byId("ba-ticks");
    this.hpText = byId("ba-hptext");
    this.xpFill = byId("ba-xpfill");
    this.lvlBadge = byId("ba-lvlbadge");
    this.lvlEl = byId("ba-lvl");
    this.goldEl = byId("ba-gold");
    this.buffsEl = byId("ba-buffs");
    this.respawnEl = byId("ba-respawn");
    this.respawnSlain = query(this.respawnEl, ".ba-rslain");
    this.respawnRing = query(this.respawnEl, ".ba-rring");
    this.respawnTimer = query(this.respawnEl, ".ba-rtimer");
    this.respawnTip = query(this.respawnEl, ".ba-rtip");
    this.itemsEl = byId("ba-items");
    // SAFETY: #ba-minimap is the <canvas> in this HUD's own template markup.
    this.minimap = byId("ba-minimap") as HTMLCanvasElement;
    this.mmCtx = this.minimap.getContext("2d")!;
    this.shopEl = byId("ba-shop");
    this.endEl = byId("ba-end");
    this.goalBanner = byId("ba-goal-banner");
    this.hintEl = byId("ba-hint");
    this.introEl = byId("ba-intro");
    this.reticleEl = byId("ba-reticle");
    this.hitDirEl = byId("ba-hitdir");
    const menuBtn = byId("ba-menu-btn");
    this.menuBtn =
      menuBtn instanceof HTMLButtonElement ? menuBtn : document.createElement("button");
    this.menuBtn.addEventListener("click", backToLobby);
    const kit = document.getElementById("ba-kit-btn");
    if (kit instanceof HTMLButtonElement) {
      this.kitButton = kit;
      kit.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!this.disposed && !this.shownEnd && !this.presentationBlocked) this.kitAction?.();
      });
      for (const name of ["pointerdown", "pointerup"])
        kit.addEventListener(name, (event) => event.stopPropagation());
      kit.addEventListener("keydown", sealKitActivation);
      kit.addEventListener("keyup", sealKitActivation);
    }
    this.arrowCoin = { el: arrowEl("ba-arrow-coin"), lastTf: "", on: false };
    this.arrowDelivery = { el: arrowEl("ba-arrow-delivery"), lastTf: "", on: false };

    // sound is muted by default (opt-in) — M is the one mute toggle
    window.addEventListener("keydown", this.onMuteKey);

    // touch path to the scoreboard (Tab-only on desktop): tapping the timer
    // pins/unpins it
    this.timerEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.boardTapped = !this.boardTapped;
    });

    const abilEl = byId("ba-abilities");
    for (const key of ALL_ABILITY_KEYS) {
      // spacer splits the levelled 1/2/3/4 group from the flat ⇧/␣ util pair
      if (key === "DASH") {
        const gap = document.createElement("div");
        gap.className = "ba-abil-gap";
        abilEl.appendChild(gap);
      }
      const util = UTIL_KEYS.has(key);
      const wrap = document.createElement("div");
      wrap.className = key === "R" ? "ba-abil ult" : util ? "ba-abil util" : "ba-abil";
      const img = document.createElement("img");
      img.className = "ba-ic";
      img.alt = "";
      img.draggable = false;
      const cd = document.createElement("div");
      cd.className = "ba-cd";
      const keycap = document.createElement("div");
      keycap.className = "ba-key";
      keycap.textContent = KEYCAP[key];
      const cdText = document.createElement("div");
      cdText.className = "ba-cdtext";
      const pips = document.createElement("div");
      pips.className = "ba-pips";
      wrap.append(img, cd, keycap, cdText, pips);
      abilEl.appendChild(wrap);
      this.abilityEls.set(key, {
        wrap,
        img,
        cdText,
        pips,
        lastCd: -1,
        lastRank: -1,
        wasOnCd: false,
        lastText: "",
      });
    }

    // item belt: 6 fixed sockets, filled by signature
    for (let i = 0; i < MAX_ITEMS; i++) {
      const chip = document.createElement("div");
      chip.className = "ba-item-chip empty";
      const img = document.createElement("img");
      img.className = "ba-ii";
      img.alt = "";
      img.draggable = false;
      const key = document.createElement("span");
      key.className = "ba-ik";
      key.textContent = this.ITEM_KEYS[i] ?? "";
      const cd = document.createElement("div");
      cd.className = "ba-icd";
      chip.append(img, key, cd);
      // tappable belt: pointerdown (not click — no 300ms delay, works mid-drag)
      // queues the slot; game-scene drains alongside the 5–0 keys. This is the
      // only way touch players can fire item actives.
      const slot = i;
      chip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.itemTaps.push(slot);
      });
      this.itemsEl.appendChild(chip);
      this.itemSockets.push({ chip, img, cd, lastPct: -1, lastText: "", lastRdy: false });
    }

    this.buildShop();
  }

  private buildShop(): void {
    const rows = ITEMS.map(
      (it) =>
        `<button class="ba-item${it.active ? " active-item" : ""}" data-id="${it.id}"><img class="ba-si" src="${iconUrl(it.icon)}" alt="" draggable="false"><span class="ba-icol"><span class="ba-iname">${it.name}</span><span class="ba-idesc">${it.desc}</span></span><span class="ba-icost">${it.cost}g</span></button>`,
    ).join("");
    this.shopEl.innerHTML = `<div class="ba-shop-head">SHOP <span class="ba-shop-hint">(B to close · only in base)</span></div><div class="ba-shop-grid">${rows}</div>`;
    this.shopEl.querySelectorAll<HTMLButtonElement>(".ba-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (!id) return;
        const it = ITEM_BY_ID[id];
        const me = this.lastMe;
        if (it && me && me.gold >= it.cost && me.items.length < MAX_ITEMS) this.sfx.uiBuy();
        else this.sfx.uiDeny();
        this.shop.buy(id);
      });
    });
  }

  /** Drain belt-chip taps (slots 0-5). The touch complement to the 5–0 keys. */
  consumeItemTaps(): number[] {
    if (this.itemTaps.length === 0) return this.itemTaps;
    const taps = this.itemTaps;
    this.itemTaps = [];
    return taps;
  }

  toggleShop(): void {
    if (this.disposed || this.shownEnd) return;
    this.shopOpen = !this.shopOpen;
    this.shopEl.hidden = !this.shopOpen;
    if (this.shopOpen) this.sfx.uiOpen();
    else this.sfx.uiClose();
  }
  get isShopOpen(): boolean {
    return this.shopOpen;
  }

  // ── public onboarding surfaces (called by the scene) ──

  /** Intro overlay: "3" / "2" / "1" / "FIGHT!" numerals or the online joining
   *  banner (any short line). The scene drives timing; empty string hides.
   *  Change-gated internally — safe to call every frame. */
  showIntro(text: string): void {
    if (this.disposed) return;
    if (this.shownEnd || this.presentationBlocked) text = "";
    if (text === this.introText) return;
    this.introText = text;
    const el = this.introEl;
    if (text === "") {
      el.classList.remove("show");
      return;
    }
    el.textContent = text;
    el.classList.toggle("fight", text === "FIGHT!");
    el.classList.toggle("small", text.length > 6);
    el.classList.add("show");
    el.classList.remove("pop");
    void el.offsetWidth; // retrigger the pop animation per numeral
    el.classList.add("pop");
  }

  /** Contextual hint slot (fed by render/hints.ts via the scene). Empty hides. */
  showHint(text: string): void {
    if (this.disposed) return;
    if (this.shownEnd || this.presentationBlocked) text = "";
    if (text === this.hintText) return;
    this.hintText = text;
    if (text === "") {
      this.hintEl.classList.remove("show");
    } else {
      this.hintEl.textContent = text;
      this.hintEl.classList.add("show");
    }
  }

  // ── per-frame update ──
  update(
    w: World,
    me: Unit,
    scoreHeld = false,
    frameDt = Math.max(0, (w.now - this.lastNow) / 1000),
  ): void {
    if (this.disposed) return;
    // A snapshot/world replacement can leave the ended phase without reloading.
    // Remove result masking and pending celebration before this world's frame.
    if (this.shownEnd && (w.phase !== "ended" || !w.winner)) this.updateEnd(w, me);
    this.updatePresentation(frameDt);
    this.lastMe = me;
    if (me.killStreak > this.bestStreak) this.bestStreak = me.killStreak;
    if (w.phase === "ended") {
      this.updateEnd(w, me);
      this.dropIncomingPresentation();
      this.lastNow = w.now;
      return;
    }
    if (w.suddenDeath && !this.sawSuddenDeath && !this.presentationBlocked)
      this.queueToast({ text: "SUDDEN DEATH", kind: "sudden", receivedAt: this.presentationNow });
    this.sawSuddenDeath = w.suddenDeath;
    this.updateLowHp(w, me);
    this.updatePlates(w, me);
    this.updateVitals(w, me);
    this.updateAbilities(w, me);
    this.updateItems(w, me);
    this.updateBuffs(w, me);
    this.updateTop(w);
    this.updateBoard(w, me, scoreHeld || this.boardTapped);
    this.updateRespawn(w, me);
    this.updateGoalBanner(w);
    this.updateMenuBtn(w);
    this.updateReticle(w, me);
    this.updateHitDir(w, me);
    this.updateArrows();
    this.drawMinimap(w, me);
    this.drainFeed(w);
    this.updateShop(me);
    this.updateEnd(w, me);
    this.lastNow = w.now;
  }

  /** A late visitor sees the accepted result without inventing a player seat. */
  updateUnassigned(w: World, frameDt: number): void {
    if (this.disposed || w.phase !== "ended") return;
    this.updatePresentation(frameDt);
    this.lastMe = null;
    this.updateEnd(w, null);
    this.dropIncomingPresentation();
    this.lastNow = w.now;
  }

  /** Only an accepted new match rewinds these sim-clock cursors. Baseline its
   * observed hits; neither a stale ring nor a ready/respawn cue may replay. */
  resetMatch(w: World, me: Unit | null): void {
    if (this.disposed) return;
    this.coinState = null;
    this.deliveryState = null;
    this.plateKeepOutAt = 0;
    this.clearPresentation();
    this.dropIncomingPresentation();
    this.presentationNow = 0;
    this.shownEnd = false;
    this.endEl.hidden = true;
    this.root.classList.remove("ba-ended");
    this.shopOpen = false;
    this.shopEl.hidden = true;
    this.boardTapped = false;
    this.boardForced = false;
    this.boardSig = "";
    this.boardEl.classList.remove("force");
    this.boardEl.textContent = "";
    for (const plate of this.plates.values()) plate.wrap.remove();
    this.plates.clear();
    for (const arrow of [this.arrowCoin, this.arrowDelivery]) {
      arrow.on = false;
      arrow.el.classList.remove("on");
    }
    this.itemTaps = [];
    this.bestStreak = me?.killStreak ?? 0;
    this.sawSuddenDeath = false;
    this.lastMe = null;
    this.lastNow = this.lastReadySoundAt = w.now;
    this.lastAttackSeen = me?.lastAttackAt ?? 0;
    this.lastHitSeen = me?.lastHitAt ?? 0;
    this.fireUntil = this.hitFlashUntil = this.hitDirUntil = 0;
    this.hitFlashCrit = false;
    this.reticleVisible = false;
    this.reticleEl.classList.remove("show", "fire", "hit", "hitcrit");
    this.lastHitDirDeg = 1e9;
    this.lastHitDirOp = 0;
    this.hitDirEl.style.opacity = "0";
    this.lowHpEl.style.opacity = this.lowHpEl2.style.opacity = "0";
    this.lastLowOp = this.lastLowOp2 = 0;
    this.hbPhase = -1;
    this.lastLevel = 0;
    this.lvlBadge.classList.remove("lvlup");
    this.hpGhost = me ? Math.max(0, Math.min(1, me.hp / Math.max(1, me.maxHp))) : 1;
    this.respawnShown = false;
    this.respawnFor = 0;
    this.lastRespawnCeil = -1;
    this.respawnEl.hidden = true;
    this.buffSeen.clear();
    this.buffEls.clear();
    this.buffScratch.length = 0;
    this.buffSig = "";
    this.buffsEl.textContent = "";
    for (const el of this.abilityEls.values()) {
      el.wasOnCd = false;
      el.wrap.classList.remove("ready");
    }
    this.showHint("");
    this.showIntro("");
  }

  /** Local presentation pause is independent of the host's live world clock. */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.presentationPaused) return;
    this.presentationPaused = paused;
    if (paused) {
      this.clearPresentation();
      this.dropIncomingPresentation();
      this.showHint("");
      this.showIntro("");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.plateAnchors = null;
    this.kitAction = null;
    this.kitButton = null;
    this.clearPresentation();
    this.dropIncomingPresentation();
    window.removeEventListener("resize", this.remeasureTopBand);
    window.removeEventListener("keydown", this.onMuteKey);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    for (const el of this.ownedElements) el.remove();
    this.ownedElements = [];
    this.ownedStyle?.remove();
    this.ownedStyle = null;
    this.lowHpEl.remove();
    this.lowHpEl2.remove();
  }

  /** Red danger vignette that intensifies below 35% HP, with a heartbeat throb
   *  under 20%. Two reused nodes; opacity only, writes gated to 0.01 steps. */
  private updateLowHp(w: World, me: Unit): void {
    const frac = me.alive ? me.hp / Math.max(1, me.maxHp) : 1;
    let op = 0;
    let op2 = 0;
    if (frac < 0.35) {
      const base = ((0.35 - frac) / 0.35) * 0.55;
      op = base;
      if (frac < 0.2) {
        const s = Math.sin(w.now * 0.006);
        op = base * (0.8 + 0.2 * s);
        op2 = base * (0.8 - 0.2 * s); // opposite phase — "closing in"
        // heartbeat thump, phase-locked to the same clock as the pulse
        const phase = Math.floor(w.now / 900);
        if (phase !== this.hbPhase) {
          this.hbPhase = phase;
          this.sfx.heartbeat();
        }
      }
    }
    const q = Math.round(op * 100);
    if (q !== this.lastLowOp) {
      this.lastLowOp = q;
      this.lowHpEl.style.opacity = (q / 100).toFixed(2);
    }
    const q2 = Math.round(op2 * 100);
    if (q2 !== this.lastLowOp2) {
      this.lastLowOp2 = q2;
      this.lowHpEl2.style.opacity = (q2 / 100).toFixed(2);
    }
  }

  private drawMinimap(w: World, me: Unit): void {
    const ctx = this.mmCtx;
    const W = this.minimap.width;
    const H = this.minimap.height;
    const cx = W / 2;
    const cy = H / 2;
    const scale = (W / 2 - 5) / HEX_R; // uniform — the arena is a regular hex
    const to = (x: number, y: number): [number, number] => [cx + x * scale, cy + y * scale];
    // regular-hexagon path, vertices at k·60° (vertex on +x — mirrors the arena)
    const hexPath = (r: number): void => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };
    ctx.clearRect(0, 0, W, H);
    const frameR = W / 2 - 3;
    // arena slab
    hexPath(frameR);
    ctx.fillStyle = "rgba(14,18,28,0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(120,140,180,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // gold frame + vertex ticks (frame read)
    hexPath(frameR);
    ctx.strokeStyle = "rgba(255,210,74,0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,210,74,0.5)";
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + ca * (frameR - 7), cy + sa * (frameR - 7));
      ctx.lineTo(cx + ca * (frameR - 1), cy + sa * (frameR - 1));
      ctx.stroke();
    }
    // contents clip to the arena hex
    ctx.save();
    hexPath(frameR);
    ctx.clip();
    // throne aura + faint crown ring
    const [tx, ty] = to(ARENA.throne.x, ARENA.throne.y);
    ctx.beginPath();
    ctx.arc(tx, ty, ARENA.throne.radius * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,210,74,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, ARENA.throne.radius * scale + 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,210,74,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // pillars
    ctx.fillStyle = "rgba(120,120,140,0.45)";
    for (const o of OBSTACLES) {
      const [px, py] = to(o.x, o.y);
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    // deliveries
    for (const d of w.deliveries) {
      const [dx, dy] = to(d.x, d.y);
      ctx.fillStyle = "#66ffcc";
      ctx.fillRect(dx - 2.5, dy - 2.5, 5, 5);
    }
    // coins
    for (const coin of w.coins) {
      const [cx, cy] = to(coin.x, coin.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd24a";
      ctx.fill();
    }
    // heroes
    for (const u of w.units.values()) {
      if (u.kind !== "hero" || !u.alive) continue;
      const [ux, uy] = to(u.x, u.y);
      const isLocal = u.id === me.id;
      ctx.beginPath();
      ctx.arc(ux, uy, isLocal ? 3.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
      ctx.fill();
      if (w.leaderId === u.team) {
        ctx.strokeStyle = "#ffd24a";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isLocal) {
        // heading wedge so the world-locked minimap relates to facing
        const a = Math.atan2(u.aimX, u.aimY);
        ctx.beginPath();
        ctx.moveTo(ux + Math.sin(a) * 8, uy + Math.cos(a) * 8);
        ctx.lineTo(ux + Math.sin(a + 2.5) * 4, uy + Math.cos(a + 2.5) * 4);
        ctx.lineTo(ux + Math.sin(a - 2.5) * 4, uy + Math.cos(a - 2.5) * 4);
        ctx.closePath();
        ctx.fillStyle = hex(LOCAL_COLOR);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private updatePlates(w: World, me: Unit): void {
    if (w.now >= this.plateKeepOutAt) {
      this.plateKeepOutAt = w.now + 200;
      this.plateKeepOut = [];
      for (const id of [
        "ba-top",
        "ba-goal-banner",
        "ba-left",
        "ba-abilities",
        "ba-board",
        "ba-menu-btn",
        "ba-kit-btn",
        "ba-minimap",
      ]) {
        const element = document.getElementById(id);
        if (!element || element.hidden || (id === "ba-goal-banner" && w.gameTime >= 10)) continue;
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0)
          this.plateKeepOut.push({
            left: box.left - 6,
            top: box.top - 6,
            right: box.right + 6,
            bottom: box.bottom + 6,
          });
      }
    }
    const seen = new Set<string>();
    const candidates: PlateCandidate[] = [];
    for (const u of w.units.values()) {
      if ((u.kind !== "hero" && u.kind !== "creep") || !u.alive) continue;
      const stealthed = u.statuses.some((s) => s.kind === "stealth") && u.id !== me.id;
      if (stealthed) continue;
      // only show skeleton HP bars when they're near the player (avoid clutter)
      const distance = Math.hypot(u.x - me.x, u.y - me.y);
      if (u.kind === "creep" && distance > 22) continue;
      seen.add(u.id);
      let plate = this.plates.get(u.id);
      if (!plate) {
        const wrap = document.createElement("div");
        wrap.className = "ba-plate" + (u.kind === "creep" ? " creep" : "");
        const isLocal = u.id === me.id;
        const col =
          u.kind === "creep" ? "#b8c0d0" : isLocal ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
        const name = document.createElement("div");
        name.className = "ba-pname";
        name.style.color = col;
        name.textContent = u.kind === "creep" ? "" : u.name;
        const bar = document.createElement("div");
        bar.className = "ba-php";
        const fill = document.createElement("div");
        fill.className = "ba-phpfill";
        fill.style.background =
          u.kind === "creep" ? "#c8a0a0" : u.team === me.team ? "#5dd66b" : "#ff5a52";
        bar.append(fill);
        wrap.append(name, bar);
        byId("ba-plates").appendChild(wrap);
        plate = { wrap, fill, name };
        this.plates.set(u.id, plate);
      }
      plate.wrap.style.display = "none";
      const anchor = this.plateAnchors?.(u.id);
      const s = anchor
        ? this.view.worldToScreen(anchor.x, anchor.z, anchor.y)
        : this.view.worldToScreen(u.x, u.y, terrainHeight(u.x, u.y) + 2);
      if (
        !s.visible ||
        s.x < 8 ||
        s.x > window.innerWidth - 8 ||
        s.y < 4 ||
        s.y > window.innerHeight - 8
      )
        continue;
      const local = u.id === me.id;
      const recent = w.now - u.lastHitAt < 2000 && u.lastHitAt > 0;
      const compact = u.kind === "creep" || (!local && distance > 24 && !recent);
      const halfWidth = compact ? 17 : 56;
      const top = s.y - (compact ? 9 : 24);
      if (s.x < halfWidth || s.x > window.innerWidth - halfWidth || top < 4) continue;
      candidates.push({
        id: u.id,
        x: s.x,
        y: top,
        distance,
        priority: local
          ? 0
          : u.kind === "hero" && (distance < 16 || recent)
            ? 1
            : u.kind === "hero"
              ? 2
              : 3,
        compact,
      });
      plate.fill.style.width = `${Math.max(0, (u.hp / u.maxHp) * 100)}%`;
    }
    for (const candidate of readablePlates(candidates, this.plateKeepOut)) {
      const plate = this.plates.get(candidate.id);
      if (!plate) continue;
      plate.wrap.classList.toggle("compact", candidate.compact);
      plate.wrap.style.display = "block";
      plate.wrap.style.left = `${Math.round(candidate.x)}px`;
      plate.wrap.style.top = `${Math.round(candidate.y)}px`;
    }
    for (const [id, plate] of this.plates) {
      if (!seen.has(id)) {
        plate.wrap.remove();
        this.plates.delete(id);
      }
    }
  }

  /** HP bar (gradient tiers + damage ghost + 250-HP ticks), XP bar, level
   *  badge, gold. All writes change-gated. */
  private updateVitals(w: World, me: Unit): void {
    const frac = Math.max(0, Math.min(1, me.hp / Math.max(1, me.maxHp)));
    // damage ghost: snaps up with heals, bleeds down after damage
    const dt = Math.min(0.1, Math.max(0, (w.now - this.lastNow) / 1000));
    if (frac >= this.hpGhost) this.hpGhost = frac;
    else this.hpGhost = Math.max(frac, this.hpGhost - dt * 0.4);

    const hpStep = Math.round(frac * 500); // 0.2% steps
    if (hpStep !== this.lastHpStep) {
      this.lastHpStep = hpStep;
      this.hpFill.style.width = `${(hpStep / 5).toFixed(1)}%`;
    }
    const tier = frac >= 0.55 ? "hi" : frac >= 0.3 ? "mid" : "low";
    if (tier !== this.lastHpTier) {
      this.lastHpTier = tier;
      this.hpFill.classList.remove("hi", "mid", "low");
      this.hpFill.classList.add(tier);
    }
    const ghostStep = Math.round(this.hpGhost * 200); // 0.5% steps
    if (ghostStep !== this.lastGhostStep) {
      this.lastGhostStep = ghostStep;
      this.hpGhostEl.style.width = `${(ghostStep / 2).toFixed(1)}%`;
    }
    const hpTextStr = `${Math.max(0, Math.ceil(me.hp))} / ${Math.ceil(me.maxHp)}`;
    if (hpTextStr !== this.lastHpTextStr) {
      this.lastHpTextStr = hpTextStr;
      this.hpText.textContent = hpTextStr;
    }
    if (me.maxHp !== this.lastMaxHp) {
      this.lastMaxHp = me.maxHp;
      this.hpTicksEl.style.backgroundSize = `${(250 / Math.max(1, me.maxHp)) * 100}% 100%`;
    }
    // XP progress toward the next level (mana is dead sim data — no mana bar)
    const lo = XP_CURVE[me.level - 1] ?? 0;
    const hiXp = XP_CURVE[me.level] ?? lo + 1;
    const xpFrac =
      me.level >= LEVEL_CAP ? 1 : Math.max(0, Math.min(1, (me.xp - lo) / Math.max(1, hiXp - lo)));
    const xpStep = Math.round(xpFrac * 200);
    if (xpStep !== this.lastXpStep) {
      this.lastXpStep = xpStep;
      this.xpFill.style.width = `${(xpStep / 2).toFixed(1)}%`;
    }
    if (me.level !== this.lastLevel) {
      const first = this.lastLevel === 0;
      this.lastLevel = me.level;
      this.lvlEl.textContent = `${me.level}`;
      if (!first) {
        this.lvlBadge.classList.remove("lvlup");
        void this.lvlBadge.offsetWidth;
        this.lvlBadge.classList.add("lvlup");
      }
    }
    const goldStr = `${Math.floor(me.gold)}g`;
    if (goldStr !== this.lastGoldStr) {
      this.lastGoldStr = goldStr;
      this.goldEl.textContent = goldStr;
    }
  }

  private updateAbilities(w: World, me: Unit): void {
    const def = CHAMP_BY_ID[me.champId];
    if (!def) return;
    if (me.champId !== this.champBound) {
      this.champBound = me.champId;
      for (const key of ALL_ABILITY_KEYS) {
        const el = this.abilityEls.get(key)!;
        el.img.src = abilityIcon(me.champId, key);
        el.lastRank = -1; // force pip rebuild
      }
    }
    for (const key of ALL_ABILITY_KEYS) {
      const el = this.abilityEls.get(key)!;
      const slot = me.abilities[key];
      const ad = def.abilities[key];
      const readiness = abilityReadiness(me, key, w.now);
      el.wrap.classList.toggle("blocked", readiness.kind === "blocked");
      el.wrap.classList.toggle("queued", readiness.queued);
      // DASH/JUMP are flat (maxRank 1): no rank pips, never level-locked.
      const util = UTIL_KEYS.has(key);
      if (!util && slot.rank !== el.lastRank) {
        el.lastRank = slot.rank;
        let pips = "";
        for (let i = 0; i < ad.maxRank; i++)
          pips += i < slot.rank ? "<i class='on'></i>" : "<i></i>";
        el.pips.innerHTML = pips;
      }
      if (!util && slot.rank < 1) {
        el.wrap.classList.add("locked");
        if (el.lastCd !== 0) {
          el.lastCd = 0;
          el.wrap.style.setProperty("--cd", "0");
        }
        const text = key === "R" ? "Lv4" : "";
        if (text !== el.lastText) {
          el.lastText = text;
          el.cdText.textContent = text;
        }
        el.wasOnCd = false;
        continue;
      }
      el.wrap.classList.remove("locked");
      const cdLeft = Math.max(0, (slot.readyAt - w.now) / 1000);
      const cdTotal = Math.max(0.01, valAt(ad.cooldown, util ? 1 : slot.rank));
      const frac = cdLeft > 0 ? Math.min(1, cdLeft / cdTotal) : 0;
      const pct = Math.round(frac * 100);
      if (pct !== el.lastCd) {
        el.lastCd = pct;
        el.wrap.style.setProperty("--cd", `${pct}`);
      }
      el.wrap.classList.toggle("oncd", frac > 0);
      if (
        el.wasOnCd &&
        readiness.kind === "available" &&
        !readiness.queued &&
        !this.presentationBlocked
      ) {
        el.wrap.classList.remove("ready");
        void el.wrap.offsetWidth;
        el.wrap.classList.add("ready");
        if (w.now - this.lastReadySoundAt > 150) {
          this.lastReadySoundAt = w.now;
          this.sfx.abilityReady();
        }
      }
      el.wasOnCd = frac > 0;
      const countdown =
        cdLeft > 0 ? (cdLeft < 10 ? cdLeft.toFixed(1) : `${Math.ceil(cdLeft)}`) : "";
      const label = readiness.queued
        ? "QUEUED"
        : readiness.kind === "blocked"
          ? readiness.label
          : "";
      const text = label ? `${label}${countdown ? `\n${countdown}` : ""}` : countdown;
      if (text !== el.lastText) {
        el.lastText = text;
        el.cdText.textContent = text;
      }
    }
  }

  private readonly ITEM_KEYS = ["5", "6", "7", "8", "9", "0"];
  private updateItems(w: World, me: Unit): void {
    const sig = `${this.shopOpen}:${me.items.join(",")}`;
    if (sig !== this.itemSig) {
      this.itemSig = sig;
      for (let i = 0; i < MAX_ITEMS; i++) {
        const sock = this.itemSockets[i]!;
        const id = me.items[i];
        const it = id ? ITEM_BY_ID[id] : undefined;
        sock.chip.hidden = !it && !this.shopOpen;
        if (it) {
          sock.chip.className = `ba-item-chip${it.active ? " active" : ""}`;
          sock.img.src = iconUrl(it.icon);
        } else {
          sock.chip.className = "ba-item-chip empty";
        }
        sock.lastPct = -1;
        sock.lastText = "";
        sock.lastRdy = false;
        sock.cd.style.height = "0";
        sock.cd.textContent = "";
      }
    }
    // active-item cooldown overlays (vertical fill — long cds read better small)
    for (let i = 0; i < MAX_ITEMS; i++) {
      const id = me.items[i];
      if (!id) continue;
      const it = ITEM_BY_ID[id];
      if (!it?.active) continue;
      const sock = this.itemSockets[i]!;
      const left = Math.max(0, ((me.itemReadyAt[id] ?? 0) - w.now) / 1000);
      const pct =
        it.active.cooldown > 0 ? Math.round(Math.min(1, left / it.active.cooldown) * 100) : 0;
      if (pct !== sock.lastPct) {
        sock.lastPct = pct;
        sock.cd.style.height = `${pct}%`;
      }
      const text = left > 0 ? left.toFixed(0) : "";
      if (text !== sock.lastText) {
        sock.lastText = text;
        sock.cd.textContent = text;
      }
      const rdy = left <= 0;
      if (rdy !== sock.lastRdy) {
        sock.lastRdy = rdy;
        sock.chip.classList.toggle("rdy", rdy);
      }
    }
  }

  /** Buff/debuff chips from synced statuses (+ synthetic empower). DOM rebuild
   *  gated on the kind-set signature; per-frame only the --t ring var and the
   *  seconds text, both change-gated. Hex (no icon art) renders a 🍄 glyph —
   *  it polymorphs you into a mushroom, so the glyph IS the read. */
  private updateBuffs(w: World, me: Unit): void {
    const chips = this.buffScratch;
    chips.length = 0;
    for (const s of me.statuses) {
      if (s.until <= w.now) continue;
      if (statusIcon(s.kind) === null && s.kind !== "hex") continue; // silence etc: no chip
      const existing = chips.find((c) => c.kind === s.kind);
      if (existing) existing.until = Math.max(existing.until, s.until);
      else chips.push({ kind: s.kind, until: s.until });
    }
    if (me.empowerNext > 0) chips.push({ kind: "empower", until: -1 });

    // duration bookkeeping (statuses only carry `until`; track first-seen)
    for (const c of chips) {
      if (c.until < 0) continue;
      const prev = this.buffSeen.get(c.kind);
      if (!prev || c.until > prev.until)
        this.buffSeen.set(c.kind, { seenAt: w.now, until: c.until });
    }
    for (const kind of this.buffSeen.keys()) {
      if (!chips.some((c) => c.kind === kind)) this.buffSeen.delete(kind);
    }

    let sig = "";
    for (const c of chips) sig += c.kind + "|";
    if (sig !== this.buffSig) {
      this.buffSig = sig;
      this.buffsEl.textContent = "";
      this.buffEls.clear();
      for (const c of chips) {
        const chip = document.createElement("div");
        chip.className = DEBUFF_KINDS.has(c.kind) ? "ba-buff debuff" : "ba-buff";
        const icon = statusIcon(c.kind);
        if (icon !== null) {
          const img = document.createElement("img");
          img.src = icon;
          img.alt = "";
          img.draggable = false;
          chip.appendChild(img);
        } else {
          const glyph = document.createElement("span");
          glyph.className = "ba-bglyph";
          glyph.textContent = "🍄";
          chip.appendChild(glyph);
        }
        const ring = document.createElement("i");
        ring.className = "ring";
        const sec = document.createElement("b");
        chip.append(ring, sec);
        this.buffsEl.appendChild(chip);
        this.buffEls.set(c.kind, { ring, sec, lastT: -1, lastSec: "" });
      }
    }
    for (const c of chips) {
      const el = this.buffEls.get(c.kind);
      if (!el) continue;
      let pct = 100;
      let secStr = "";
      if (c.until >= 0) {
        const seen = this.buffSeen.get(c.kind);
        const total = seen ? Math.max(1, c.until - seen.seenAt) : 1;
        const remainMs = Math.max(0, c.until - w.now);
        pct = Math.round(Math.min(1, remainMs / total) * 100);
        const remainS = remainMs / 1000;
        secStr = remainS >= 1 ? `${Math.ceil(remainS)}` : "";
      }
      if (pct !== el.lastT) {
        el.lastT = pct;
        el.ring.style.setProperty("--t", `${pct}`);
      }
      if (secStr !== el.lastSec) {
        el.lastSec = secStr;
        el.sec.textContent = secStr;
      }
    }
  }

  private updateTop(w: World): void {
    const remain = Math.max(0, w.matchTime - w.gameTime);
    const m = Math.floor(remain / 60);
    const s = Math.floor(remain % 60);
    const timerStr = `${m}:${s.toString().padStart(2, "0")}`;
    if (timerStr !== this.lastTimerStr) {
      this.lastTimerStr = timerStr;
      this.timerEl.textContent = timerStr;
      this.timerEl.classList.toggle("low", remain < 30);
    }
    const goalStr = w.suddenDeath ? "SUDDEN DEATH" : `FIRST TO ${w.killGoal}`;
    if (goalStr !== this.lastGoalStr) {
      this.lastGoalStr = goalStr;
      this.goalEl.textContent = goalStr;
    }
    // Countdown and arrow share one retained, authoritative target.
    this.coinState = coinObjective(w, this.lastMe, this.coinState?.target?.id ?? null);
    const coinStr = this.coinState.text;
    if (coinStr !== this.lastObjCoin) {
      this.lastObjCoin = coinStr;
      this.objCoinEl.textContent = coinStr;
      this.objCoinEl.className = this.coinState.live ? "coin live" : "coin";
    }
    this.deliveryState = deliveryObjective(w, this.lastMe, this.deliveryState?.target?.id ?? null);
    const dropStr = this.deliveryState.text;
    if (dropStr !== this.lastObjDrop) {
      this.lastObjDrop = dropStr;
      this.objDropEl.textContent = dropStr;
      this.objDropEl.className = this.deliveryState.live ? "drop live" : "drop";
    }
  }

  /** Leaderboard. Tab (scoreHeld) forces it visible (even on mobile) and
   *  expands rows to K/D/A · gold · item count. Rebuild is signature-gated. */
  private updateBoard(w: World, me: Unit, scoreHeld: boolean): void {
    if (scoreHeld !== this.boardForced) {
      this.boardForced = scoreHeld;
      this.boardEl.classList.toggle("force", scoreHeld);
    }
    const heroes = [...w.units.values()]
      .filter((u) => u.kind === "hero")
      .sort((a, b) => b.kills - a.kills || b.gold - a.gold)
      .slice(0, 6);
    let sig = scoreHeld ? "x" : "-";
    for (const u of heroes)
      sig += `${u.id}:${u.kills}/${u.deaths}/${u.assists}/${Math.floor(u.gold)}/${u.items.length};`;
    if (sig === this.boardSig) return;
    this.boardSig = sig;
    this.boardEl.innerHTML = heroes
      .map((u) => {
        const col = u.id === me.id ? hex(LOCAL_COLOR) : hex(teamColor(u.team));
        const lead = w.leaderId === u.team ? "★" : "";
        const kda = scoreHeld ? `${u.kills}/${u.deaths}/${u.assists}` : `${u.kills}/${u.deaths}`;
        const extra = scoreHeld
          ? `<span class="ba-rg">${Math.floor(u.gold)}g</span><span class="ba-ri">${u.items.length} it</span>`
          : "";
        return `<div class="ba-row${u.id === me.id ? " me" : ""}${scoreHeld ? " x" : ""}"><span class="ba-dot" style="background:${col}"></span><span class="ba-rn">${lead}${htmlText(u.name)}</span><span class="ba-rk">${kda}</span>${extra}</div>`;
      })
      .join("");
  }

  /** Death screen: killer attribution + rotating tip + conic respawn ring. */
  private updateRespawn(w: World, me: Unit): void {
    if (!me.alive && me.respawnAt > 0) {
      const left = Math.max(0, (me.respawnAt - w.now) / 1000);
      if (!this.respawnShown) {
        this.respawnShown = true;
        this.respawnEl.hidden = false;
      }
      if (this.respawnFor !== me.respawnAt) {
        this.respawnFor = me.respawnAt;
        this.respawnSlain.textContent = `Slain by ${this.fx.lastDeath?.killerName ?? "the arena"}`;
        this.respawnTip.textContent = `TIP: ${TIPS[me.deaths % TIPS.length]}`;
        this.lastRespawnCeil = -1;
      }
      const total = Math.max(0.1, respawnTime(me.level));
      const pct = Math.round(Math.min(1, Math.max(0, 1 - left / total)) * 100);
      if (pct !== this.lastRespawnPct) {
        this.lastRespawnPct = pct;
        this.respawnRing.style.setProperty("--cd", `${pct}`);
      }
      const text = `${left.toFixed(1)}s`;
      if (text !== this.lastRespawnText) {
        this.lastRespawnText = text;
        this.respawnTimer.textContent = text;
      }
      const ceilLeft = Math.ceil(left);
      if (ceilLeft !== this.lastRespawnCeil) {
        this.lastRespawnCeil = ceilLeft;
        if (ceilLeft >= 1 && ceilLeft <= 3) this.sfx.respawnTick();
      }
    } else if (this.respawnShown) {
      this.respawnShown = false;
      this.respawnEl.hidden = true;
      if (me.alive) this.sfx.respawnGo();
    }
  }

  /** ≤8-word goal banner, visible 0–8s, faded out by 10s. */
  private updateGoalBanner(w: World): void {
    const t = w.gameTime;
    const op = t < 8 ? "1" : t < 10 ? ((10 - t) / 2).toFixed(2) : "0";
    if (op !== this.lastBannerOp) {
      this.lastBannerOp = op;
      this.goalBanner.style.opacity = op;
    }
  }

  /** "HEROES ▸" escape hatch to the lobby — solo only, first 20s. */
  private updateMenuBtn(w: World): void {
    const hide = this.online || w.gameTime > 20;
    if (hide !== this.menuBtnHidden) {
      this.menuBtnHidden = hide;
      this.menuBtn.hidden = hide;
    }
  }

  /** Center reticle: fire-expand on your swings, gold/crit flash on your hits
   *  (fed by fx.localHits). Hidden while unlocked / shopping / dead. Touch is
   *  FPS-framed too (look stick turns the view), so it keeps the crosshair. */
  private updateReticle(w: World, me: Unit): void {
    const touch = document.body.classList.contains("ba-touch-on");
    const show = me.alive && !this.shopOpen && (touch || document.pointerLockElement !== null);
    if (show !== this.reticleVisible) {
      this.reticleVisible = show;
      this.reticleEl.classList.toggle("show", show);
    }
    if (!show) return;
    if (me.lastAttackAt !== this.lastAttackSeen) {
      this.lastAttackSeen = me.lastAttackAt;
      this.fireUntil = w.now + 120;
      this.reticleEl.classList.add("fire");
    } else if (this.fireUntil > 0 && w.now >= this.fireUntil) {
      this.fireUntil = 0;
      this.reticleEl.classList.remove("fire");
    }
    const hits = this.fx.localHits;
    if (hits && hits.length > 0) {
      let crit = false;
      for (const h of hits) crit = crit || h.crit;
      hits.length = 0;
      this.hitFlashUntil = w.now + 150;
      this.hitFlashCrit = crit;
      this.reticleEl.classList.toggle("hit", !crit);
      this.reticleEl.classList.toggle("hitcrit", crit);
    } else if (this.hitFlashUntil > 0 && w.now >= this.hitFlashUntil) {
      this.hitFlashUntil = 0;
      this.reticleEl.classList.remove("hit", "hitcrit");
    }
  }

  /** Conic ring segment pointing at whoever just hit you. Screen angle comes
   *  from two worldToScreen projections — no View internals touched. */
  private updateHitDir(w: World, me: Unit): void {
    if (me.alive && me.lastHitAt > 0 && me.lastHitAt !== this.lastHitSeen) {
      this.lastHitSeen = me.lastHitAt;
      this.hitDirUntil = w.now + 600;
      const s1 = this.view.worldToScreen(me.x, me.y);
      const s2 = this.view.worldToScreen(me.x - me.lastHitDx * 4, me.y - me.lastHitDy * 4);
      const ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      const deg = Math.round((ang * 180) / Math.PI + 90);
      if (deg !== this.lastHitDirDeg) {
        this.lastHitDirDeg = deg;
        this.hitDirEl.style.setProperty("--a", `${deg}deg`);
      }
    }
    const left = this.hitDirUntil - w.now;
    const op = left > 0 ? 0.9 * (left / 600) : 0;
    const q = Math.round(op * 50); // 0.02 steps
    if (q !== this.lastHitDirOp) {
      this.lastHitDirOp = q;
      this.hitDirEl.style.opacity = (q / 50).toFixed(2);
    }
  }

  /** Off-screen coin/delivery edge arrows: transform-only, 40px inset. */
  private updateArrows(): void {
    const coin = this.coinState?.target;
    this.placeArrow(this.arrowCoin, coin?.x, coin?.y);
    const drop = this.deliveryState?.target;
    this.placeArrow(this.arrowDelivery, drop?.x, drop?.y);
  }

  private placeArrow(a: Arrow, x?: number, y?: number): void {
    if (x === undefined || y === undefined) {
      if (a.on) {
        a.on = false;
        a.el.classList.remove("on");
      }
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const s = this.view.worldToScreen(x, y, terrainHeight(x, y) + 1.4);
    const behind = !s.visible && s.x === 0 && s.y === 0;
    const onScreen = s.visible && s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H;
    if (onScreen) {
      if (a.on) {
        a.on = false;
        a.el.classList.remove("on");
      }
      return;
    }
    // behind the camera: point down at the bottom edge (projection is useless)
    const px = behind ? W / 2 : Math.max(40, Math.min(W - 40, s.x));
    const py = behind ? H - 40 : Math.max(40, Math.min(H - 40, s.y));
    const deg = behind
      ? 180
      : Math.round((Math.atan2(py - H / 2, px - W / 2) * 180) / Math.PI + 90);
    const tf = `translate(${Math.round(px)}px,${Math.round(py)}px) translate(-50%,-50%) rotate(${deg}deg)`;
    if (tf !== a.lastTf) {
      a.lastTf = tf;
      a.el.style.transform = tf;
    }
    if (!a.on) {
      a.on = true;
      a.el.classList.add("on");
    }
  }

  private dropIncomingPresentation(): void {
    this.fx.feed.length = 0;
    this.fx.toasts.length = 0;
  }

  private clearPresentation(): void {
    for (const row of this.feedRows) row.el.remove();
    for (const toast of this.visibleToasts) toast.el.remove();
    this.feedRows = [];
    this.visibleToasts = [];
    this.pendingToasts = [];
    this.confetti = [];
  }

  /** Two visible notices + three plain pending records. Priority displaces
   * lower-priority decoration; equal priority stays FIFO and expires promptly. */
  private queueToast(notice: Toast): void {
    if (this.presentationBlocked || this.shownEnd || this.disposed) return;
    if (this.visibleToasts.length < 2) {
      this.presentToast(notice);
      return;
    }
    const priority = TOAST_STYLE[notice.kind].priority;
    const lowest = Math.min(...this.visibleToasts.map((t) => TOAST_STYLE[t.notice.kind].priority));
    if (priority > lowest) {
      const index = this.visibleToasts.findIndex(
        (t) => TOAST_STYLE[t.notice.kind].priority === lowest,
      );
      const displaced = this.visibleToasts.splice(index, 1)[0];
      displaced?.el.remove();
      this.presentToast(notice);
      return;
    }
    if (this.pendingToasts.some((p) => p.kind === notice.kind && p.text === notice.text)) return;
    if (this.pendingToasts.length >= 3) {
      const lowest = Math.min(...this.pendingToasts.map((p) => TOAST_STYLE[p.kind].priority));
      if (priority < lowest) return;
      const index = this.pendingToasts.findIndex((p) => TOAST_STYLE[p.kind].priority === lowest);
      this.pendingToasts.splice(index, 1);
    }
    this.pendingToasts.push(notice);
  }

  private presentToast(notice: Toast): void {
    const el = document.createElement("div");
    el.className = "ba-toast " + notice.kind;
    el.textContent = notice.text;
    this.toastEl.appendChild(el);
    this.visibleToasts.push({
      notice,
      el,
      until: this.presentationNow + TOAST_STYLE[notice.kind].life,
    });
  }

  private updatePresentation(frameDt: number): void {
    if (this.presentationBlocked) {
      this.dropIncomingPresentation();
      return;
    }
    if (Number.isFinite(frameDt)) this.presentationNow += Math.max(0, frameDt) * 1000;
    const now = this.presentationNow;
    const feedCap = window.innerWidth < 720 ? 3 : 5;
    this.feedRows = this.feedRows.filter((row, i) => {
      if (row.until > now && i >= this.feedRows.length - feedCap) return true;
      row.el.remove();
      return false;
    });
    this.visibleToasts = this.visibleToasts.filter((toast) => {
      if (toast.until > now && now - toast.notice.receivedAt < TOAST_MAX_AGE) return true;
      toast.el.remove();
      return false;
    });
    this.pendingToasts = this.pendingToasts.filter((p) => now - p.receivedAt < TOAST_MAX_AGE);
    while (this.visibleToasts.length < 2 && this.pendingToasts.length > 0) {
      const highest = Math.max(...this.pendingToasts.map((p) => TOAST_STYLE[p.kind].priority));
      const index = this.pendingToasts.findIndex((p) => TOAST_STYLE[p.kind].priority === highest);
      const next = this.pendingToasts.splice(index, 1)[0];
      if (next) this.presentToast(next);
    }
    if (REDUCED_MOTION.matches) this.confetti = [];
    this.confetti = this.confetti.filter((stage) => {
      if (stage.at > now) return true;
      // A delayed frame must not collapse every missed fountain into one burst.
      if (now - stage.at < 200) this.fx.fountain(stage.x, stage.y, 16, stage.color);
      return false;
    });
  }

  private drainFeed(w: World): void {
    if (this.presentationBlocked || this.shownEnd) {
      this.dropIncomingPresentation();
      return;
    }
    const cap = window.innerWidth < 720 ? 3 : 5;
    // Only the newest rows can be visible; pressure never allocates hidden rows.
    const incoming = this.fx.feed.splice(Math.max(0, this.fx.feed.length - cap));
    this.fx.feed.length = 0;
    for (const k of incoming) {
      const row = document.createElement("div");
      row.className = "ba-kill" + (k.leader ? " leader" : "");
      const ku = w.units.get(k.killer);
      const vu = w.units.get(k.victim);
      const weapon = `<img class="ba-kw" src="${attackIcon(ku?.attackKind ?? "melee")}" alt="">`;
      row.innerHTML = `${feedSigil(ku)}<b>${htmlText(k.killerName)}</b>${weapon}${feedSigil(vu)}<span>${htmlText(k.victimName)}</span>`;
      this.feedEl.appendChild(row);
      this.feedRows.push({ el: row, until: this.presentationNow + 5000 });
      while (this.feedRows.length > cap) this.feedRows.shift()?.el.remove();
    }
    for (const notice of this.fx.toasts)
      this.queueToast({
        text: notice.text,
        kind: toastKind(notice.kind),
        receivedAt: this.presentationNow,
      });
    this.fx.toasts.length = 0;
  }

  private updateShop(me: Unit): void {
    const inBase = this.shop.canShop();
    if (this.shopOpen && !inBase) this.toggleShop();
    if (!this.shopOpen) return;
    this.shopEl.querySelectorAll<HTMLButtonElement>(".ba-item").forEach((btn) => {
      const it = ITEM_BY_ID[btn.dataset.id ?? ""];
      const owned = me.items.length >= MAX_ITEMS;
      const afford = it ? me.gold >= it.cost : false;
      btn.classList.toggle("afford", afford && !owned);
      btn.disabled = !afford || owned;
    });
  }

  /** Match-end card: title slam, winner sigil, your stat line, best-kills
   *  open loop, PLAY AGAIN / CHANGE HERO. Win confetti reuses fx.fountain. */
  private updateEnd(w: World, me: Unit | null): void {
    if (w.phase !== "ended" || !w.winner) {
      if (this.shownEnd) {
        this.shownEnd = false;
        this.endEl.hidden = true;
        this.root.classList.remove("ba-ended");
        this.clearPresentation();
        this.bestStreak = me?.killStreak ?? 0;
        this.sawSuddenDeath = false;
      }
      return;
    }
    if (this.shownEnd) {
      this.syncRematchAction();
      return;
    }
    this.shownEnd = true;
    this.clearPresentation();
    this.dropIncomingPresentation();
    this.showHint("");
    this.showIntro("");
    this.shopOpen = false;
    this.shopEl.hidden = true;
    this.boardTapped = false;
    this.itemTaps = [];
    this.root.classList.add("ba-ended");
    const won = me !== null && w.winner === me.team;
    const winner = [...w.units.values()].find((u) => u.team === w.winner);
    let best = 0;
    try {
      best = Number(localStorage.getItem("ba-best-kills") ?? "0") || 0;
    } catch {
      /* storage unavailable — skip the open loop */
    }
    const newBest = me !== null && me.kills > best;
    if (newBest) {
      try {
        localStorage.setItem("ba-best-kills", `${me?.kills ?? 0}`);
      } catch {
        /* ignore */
      }
    }
    const sigil =
      winner && winner.kind === "hero" && winner.champId
        ? `<img class="ba-es" src="${champSigil(winner.champId)}" alt="">`
        : "";
    this.endEl.hidden = false;
    this.endEl.innerHTML = `
      <div class="ba-end-card">
        <div class="ba-end-title ${me ? (won ? "win" : "loss") : ""}">${me ? (won ? "VICTORY" : "DEFEAT") : "MATCH COMPLETE"}</div>
        <div class="ba-end-sub">${sigil}${htmlText(winner?.name ?? "Someone")} takes the arena</div>
        ${
          me
            ? `<div class="ba-end-stats">
          <span><b>${me.kills}</b>K</span><span><b>${me.deaths}</b>D</span><span><b>${me.assists}</b>A</span>
          <span><b>${Math.floor(me.gold)}</b><small>GOLD HELD</small></span><span><b>${me.level}</b>Lv</span><span><b>${Math.max(this.bestStreak, me.killStreak)}</b>streak</span>
        </div>
        <div class="ba-end-best${newBest ? " nb" : ""}">${newBest ? "NEW BEST!" : `BEST: ${Math.max(best, me.kills)}`}</div>`
            : '<div class="ba-end-best">YOU JOINED AFTER THE FINAL BLOW</div>'
        }
        <div class="ba-end-btns"><button class="ba-end-btn" data-act="again">PLAY AGAIN</button><button class="ba-end-btn alt" data-act="hero">CHANGE HERO</button></div>
      </div>`;
    this.endEl.querySelectorAll<HTMLButtonElement>(".ba-end-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.act === "hero") backToLobby();
        else if (this.matchActions.kind === "online") this.matchActions.rematch();
        else location.reload();
      });
    });
    this.syncRematchAction();
    if (won && winner && !this.presentationBlocked && !REDUCED_MOTION.matches) {
      this.confetti = [0xffd24a, 0x6bff8e, 0x9fd0ff].map((color, i) => ({
        at: this.presentationNow + i * 200,
        x: winner.x,
        y: winner.y,
        color,
      }));
    }
  }

  /** Server election may change while the result card is already visible. */
  private syncRematchAction(): void {
    if (this.matchActions.kind !== "online") return;
    const button = this.endEl.querySelector<HTMLButtonElement>('[data-act="again"]');
    if (!button) return;
    const available = this.matchActions.canRematch();
    const label = available ? "START REMATCH" : "WAITING FOR HOST";
    if (button.textContent !== label) button.textContent = label;
    button.disabled = !available;
  }

  // ── styles ──
  private injectStyle(): void {
    const s = document.createElement("style");
    s.textContent = STYLE;
    document.head.appendChild(s);
    this.ownedStyle = s;
  }
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** Leave the match for champion select. `?offline=1` is a boot guarantee, not a
 *  match setting, so it survives the trip — otherwise the lobby it lands on
 *  offers PLAY ONLINE again and a session promised no socket can open one. */
function backToLobby(): void {
  location.search = isOfflineRequested() ? "?menu&offline=1" : "?menu";
}

/** Kill-feed champ sigil (heroes only — creeps/environment get no mark). */
function feedSigil(u: Unit | undefined): string {
  return u && u.kind === "hero" && u.champId
    ? `<img class="ba-ks" src="${champSigil(u.champId)}" alt="">`
    : "";
}

/** Typed child lookup (build-time markup — always present). */
function query(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector(sel);
  return el instanceof HTMLElement ? el : root;
}

function arrowEl(id: string): HTMLDivElement {
  const el = byId(id);
  return el instanceof HTMLDivElement ? el : document.createElement("div");
}

const STYLE = `
.ba-end-btn:disabled{opacity:.55;cursor:wait;transform:none;filter:none;}
[hidden]{display:none!important}
#hud.ba-ended>:not(#ba-end){visibility:hidden;pointer-events:none}
#ba-plates{position:absolute;inset:0}
.ba-plate{position:absolute;transform:translateX(-50%);text-align:center;pointer-events:none;will-change:left,top}
.ba-pname{max-width:108px;overflow:hidden;text-overflow:ellipsis;font:700 12px ui-monospace,monospace;text-shadow:0 1px 2px #000;white-space:nowrap}
.ba-plate.compact .ba-pname{display:none}
.ba-plate.compact .ba-php{width:28px;height:4px;opacity:.8}
.ba-php{width:54px;height:5px;margin:2px auto 0;background:rgba(0,0,0,.6);border-radius:3px;overflow:hidden}
.ba-phpfill{height:100%;width:100%;transition:width .12s}
#ba-top{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);text-align:center;pointer-events:none}
#ba-timer{font:800 40px ui-monospace,monospace;color:#ffd24a;text-shadow:0 3px 0 rgba(0,0,0,.5);line-height:1;font-variant-numeric:tabular-nums;pointer-events:auto;cursor:pointer;touch-action:none}
#ba-timer.low{color:#ff5a52}
#ba-goal{font:700 12px ui-monospace,monospace;letter-spacing:2px;opacity:.8;margin-top:4px;text-shadow:0 2px 5px rgba(0,0,0,.9)}
#ba-objective{display:flex;gap:14px;justify-content:center;margin-top:5px;font:700 11px ui-monospace,monospace;letter-spacing:1px;opacity:.85;font-variant-numeric:tabular-nums}
#ba-objective .coin{color:#ffd24a}
#ba-objective .drop{color:#6bffcc}
#ba-objective .live{animation:ba-obj .8s infinite alternate}
@keyframes ba-obj{from{opacity:.6}to{opacity:1}}
#ba-board{position:fixed;top:calc(12px + env(safe-area-inset-top));left:calc(12px + env(safe-area-inset-left));display:flex;flex-direction:column;gap:3px;pointer-events:none}
.ba-row{display:flex;align-items:center;gap:7px;background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px 3px 6px;font:700 13px ui-monospace,monospace;min-width:150px}
.ba-row.x{min-width:230px}
.ba-row.me{outline:1px solid rgba(70,224,255,.6)}
.ba-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.ba-rn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ba-rk{font-variant-numeric:tabular-nums;opacity:.9}
.ba-rg{font-variant-numeric:tabular-nums;color:#ffd24a}
.ba-ri{font-variant-numeric:tabular-nums;opacity:.65;font-size:11px}
#ba-feed{position:fixed;top:calc(12px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));display:flex;flex-direction:column;gap:3px;align-items:flex-end;pointer-events:none}
.ba-kill{display:flex;align-items:center;gap:5px;background:rgba(12,16,26,.6);border-radius:6px;padding:3px 9px;font:600 12px ui-monospace,monospace;animation:ba-in .2s}
.ba-kill b{color:#ffd24a}
.ba-kill.leader{outline:1px solid #ffd24a;color:#ffd24a}
.ba-ks{width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.3)}
.ba-kw{width:13px;height:13px;opacity:.8}
#ba-menu-btn{position:fixed;top:calc(148px + env(safe-area-inset-top));right:calc(64px + env(safe-area-inset-right));height:44px;padding:0 12px;pointer-events:auto;background:rgba(12,16,26,.75);border:1px solid rgba(255,210,74,.4);border-radius:8px;color:#ffd24a;font:800 12px ui-monospace,monospace;letter-spacing:1px;cursor:pointer;z-index:6}
#ba-menu-btn:hover{background:rgba(255,210,74,.15)}
#ba-kit-btn{position:fixed;top:calc(96px + env(safe-area-inset-top));right:calc(64px + env(safe-area-inset-right));min-height:44px;padding:0 12px;pointer-events:auto;background:rgba(12,16,26,.85);border:1px solid rgba(255,210,74,.5);border-radius:8px;color:#ffd24a;font:800 12px ui-monospace,monospace;cursor:pointer;z-index:6}
#ba-kit-btn:focus-visible{outline:2px solid #fff0ad;outline-offset:3px}
#ba-toasts{position:fixed;top:24%;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.ba-toast{font:800 italic 24px system-ui,sans-serif;letter-spacing:1px;text-shadow:0 2px 8px #000;animation:ba-pop .3s}
.ba-toast.leader{color:#ff5a52}
.ba-toast.delivery{color:#6bffcc}
.ba-toast.streak{color:#ffb13b}
.ba-toast.sudden{color:#ffd24a}
.ba-toast.matchend{color:#ffd24a;font-size:30px}
#ba-bottom{display:contents;pointer-events:none}
#ba-left{position:fixed;left:calc(16px + env(safe-area-inset-left));bottom:calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:flex-start;gap:6px;pointer-events:none}
#ba-buffs{display:flex;gap:5px}
.ba-buff{position:relative;width:26px;height:26px;border-radius:6px;overflow:hidden;border:1px solid rgba(107,255,142,.7);background:rgba(10,14,24,.7)}
.ba-buff.debuff{border-color:rgba(255,90,82,.8)}
.ba-buff img{position:absolute;inset:0;width:100%;height:100%}
.ba-buff .ba-bglyph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px}
.ba-buff .ring{position:absolute;inset:0;background:conic-gradient(transparent calc(var(--t,100)*1%),rgba(5,8,16,.7) 0)}
.ba-buff b{position:absolute;bottom:0;right:1px;font:800 9px ui-monospace,monospace;color:#fff;text-shadow:0 1px 2px #000;font-variant-numeric:tabular-nums}
#ba-vitals{display:flex;flex-direction:column;gap:0;width:340px}
#ba-vrow{display:flex;gap:8px;align-items:center}
#ba-lvlbadge{width:30px;height:30px;flex:0 0 auto;transform:rotate(45deg);background:#101526;border:2px solid #ffd24a;border-radius:7px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 10px -3px rgba(255,210,74,.7)}
#ba-lvlbadge span{transform:rotate(-45deg);font:800 13px ui-monospace,monospace;color:#ffd24a}
#ba-lvlbadge.lvlup{animation:ba-lvlup .6s}
@keyframes ba-lvlup{30%{transform:rotate(45deg) scale(1.35);box-shadow:0 0 22px rgba(255,210,74,.9)}}
.ba-bar{position:relative;background:rgba(0,0,0,.55);border-radius:5px;overflow:hidden}
.ba-bar.hp{flex:1;height:20px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:rgba(0,0,0,.6)}
#ba-hpghost{position:absolute;inset:0;width:100%;background:#ff8f6a;opacity:.7}
#ba-hpfill{position:absolute;inset:0;width:100%;transition:none}
#ba-hpfill.hi{background:linear-gradient(180deg,#8df59d,#3fbf55 45%,#2e9440)}
#ba-hpfill.mid{background:linear-gradient(180deg,#ffe08a,#e8a93d 45%,#b97f22)}
#ba-hpfill.low{background:linear-gradient(180deg,#ff9a8a,#e04a3a 45%,#a82f22)}
#ba-ticks{position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.5) 1px,transparent 1px) repeat-x}
.ba-bar.hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 11px ui-monospace,monospace;text-shadow:0 1px 1px #000;font-variant-numeric:tabular-nums}
.ba-bar.xp{height:5px;border-radius:3px;margin-top:3px;background:rgba(0,0,0,.55)}
#ba-xpfill{height:100%;width:0;background:linear-gradient(90deg,#b98a1e,#ffd24a);border-radius:3px}
#ba-abilities{position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(16px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:flex-end}
.ba-abil{position:relative;width:56px;height:56px;background:#0c101c;border:2px solid rgba(255,255,255,.22);border-radius:11px;overflow:hidden;box-shadow:0 3px 0 rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.6)}
.ba-abil.ult{width:62px;height:62px;border-color:rgba(255,210,74,.55)}
.ba-abil.util{width:44px;height:44px;border-color:rgba(150,200,255,.4)}
.ba-abil-gap{width:10px;flex:0 0 auto}
.ba-abil .ba-ic{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba-abil.oncd .ba-ic{filter:saturate(.3) brightness(.55)}
.ba-abil.locked .ba-ic{filter:grayscale(1) brightness(.4)}
.ba-abil.locked{opacity:.6}
.ba-abil.blocked .ba-ic{filter:saturate(.15) brightness(.4)}
.ba-abil.blocked .ba-cdtext,.ba-abil.queued .ba-cdtext{font-size:11px;white-space:pre-line;text-align:center}
.ba-abil.queued{border-color:#ffe08a}
.ba-cd{position:absolute;inset:0;background:conic-gradient(rgba(5,8,16,.85) calc(var(--cd,0)*1%),transparent 0)}
.ba-key{position:absolute;top:2px;left:2px;padding:1px 5px;border-radius:5px 0 6px 0;background:rgba(5,8,16,.85);font:800 12px ui-monospace,monospace;color:#ffd24a;text-shadow:none}
.ba-cdtext{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 18px ui-monospace,monospace;color:#fff;text-shadow:0 2px 3px #000;font-variant-numeric:tabular-nums}
.ba-pips{position:absolute;bottom:3px;left:0;right:0;display:flex;gap:3px;justify-content:center}
.ba-pips i{width:5px;height:5px;border-radius:1px;background:rgba(255,255,255,.25)}
.ba-pips i.on{background:#ffd24a;box-shadow:0 0 4px #ffd24a}
.ba-abil.ready{animation:ba-ready .4s}
@keyframes ba-ready{0%{box-shadow:0 0 0 0 rgba(255,210,74,.9)}100%{box-shadow:0 0 0 14px rgba(255,210,74,0)}}
/* MOUSE mode (menus own the cursor): swap the gameplay crosshair for a pointer */
body.ba-mouse-mode canvas{cursor:default}
#ba-items{display:flex;gap:5px;min-height:2px}
.ba-item-chip{position:relative;width:40px;height:40px;background:rgba(18,22,34,.8);border:1px solid rgba(255,255,255,.16);border-radius:7px;overflow:hidden;pointer-events:auto;touch-action:none}
.ba-item-chip.active{border-color:rgba(107,255,142,.6)}
.ba-item-chip.active.rdy{box-shadow:0 0 8px -2px #6bff8e}
.ba-item-chip.empty{background:rgba(18,22,34,.5);border-style:dashed;opacity:.5}
.ba-item-chip.empty .ba-ii{display:none}
.ba-item-chip[hidden]{display:none}
.ba-ii{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba-ik{position:absolute;top:0;left:0;padding:0 4px;border-radius:0 0 5px 0;background:rgba(5,8,16,.85);font:700 9px/13px ui-monospace,monospace;color:#ffd24a}
.ba-icd{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(10,14,24,.78);border-top:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;font:800 12px ui-monospace,monospace;color:#fff}
#ba-meta{display:flex;gap:14px;font:800 15px ui-monospace,monospace}
#ba-gold{color:#ffd24a}
#ba-goal-banner{position:fixed;top:22%;left:50%;transform:translateX(-50%);background:rgba(10,14,24,.7);border:1px solid rgba(255,210,74,.3);border-radius:12px;padding:12px 20px;font:700 18px ui-monospace,monospace;color:#fff;text-shadow:0 2px 8px #000;white-space:nowrap;pointer-events:none;transition:opacity .5s}
#ba-goal-banner b{color:#ffd24a}
#ba-hint{display:none;max-width:340px;font:700 13px/1.35 ui-monospace,monospace;color:#fff;text-shadow:0 2px 6px #000;pointer-events:none}
#ba-hint.show{display:block}
#ba-hint b{color:#ffd24a}
#ba-intro{position:fixed;top:32%;left:50%;transform:translate(-50%,-50%);font:900 italic 72px system-ui,sans-serif;color:#fff;text-shadow:0 6px 0 rgba(0,0,0,.5),0 0 40px rgba(255,210,74,.25);pointer-events:none;z-index:9;opacity:0}
#ba-intro.show{opacity:1}
#ba-intro.fight{color:#ffd24a}
#ba-intro.small{font-size:26px;letter-spacing:2px;font-style:normal}
#ba-intro.pop{animation:ba-pop .3s}
.ba-arrow{position:fixed;left:0;top:0;font:900 20px system-ui,sans-serif;text-shadow:0 2px 6px #000;pointer-events:none;will-change:transform;z-index:6;opacity:0;transition:opacity .15s}
.ba-arrow.on{opacity:.95}
#ba-arrow-coin{color:#ffd24a}
#ba-arrow-delivery{color:#6bffcc}
#ba-reticle{position:fixed;left:50%;top:50%;width:26px;height:26px;transform:translate(-50%,-50%);pointer-events:none;z-index:6;display:none}
#ba-reticle.show{display:block}
#ba-reticle i{position:absolute;background:rgba(255,255,255,.85);box-shadow:0 0 2px #000;transition:transform .09s,background .1s}
#ba-reticle i:nth-child(1){left:12px;top:0;width:2px;height:7px}
#ba-reticle i:nth-child(2){left:12px;bottom:0;width:2px;height:7px}
#ba-reticle i:nth-child(3){left:0;top:12px;width:7px;height:2px}
#ba-reticle i:nth-child(4){right:0;top:12px;width:7px;height:2px}
#ba-reticle b{position:absolute;left:12px;top:12px;width:2px;height:2px;background:rgba(255,255,255,.9);box-shadow:0 0 2px #000}
#ba-reticle.fire i{transform:scale(1.3)}
#ba-reticle.hit i{background:#ffd24a}
#ba-reticle.hitcrit i{background:#ff5a52;transform:scale(1.5)}
#ba-hitdir{position:fixed;left:50%;top:50%;width:240px;height:240px;margin:-120px;border-radius:50%;pointer-events:none;z-index:6;opacity:0;background:conic-gradient(from calc(var(--a,0deg) - 30deg),transparent 0deg,rgba(255,60,48,.75) 30deg,transparent 60deg);-webkit-mask:radial-gradient(circle,transparent 62%,#000 63%,#000 78%,transparent 79%);mask:radial-gradient(circle,transparent 62%,#000 63%,#000 78%,transparent 79%)}
#ba-minimap{position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:calc(104px + env(safe-area-inset-bottom));width:150px;height:132px;opacity:.92;pointer-events:none;filter:drop-shadow(0 0 10px rgba(0,0,0,.65))}
#ba-respawn{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(40,10,10,.3),rgba(8,8,12,.7));pointer-events:none}
.ba-rtitle{font:900 italic 56px system-ui,sans-serif;color:#ff5a52;text-shadow:0 4px 0 rgba(0,0,0,.5)}
.ba-rslain{font:600 14px ui-monospace,monospace;color:#ff9a94;margin-top:6px}
.ba-rwrap{position:relative;width:72px;height:72px;margin-top:14px}
.ba-rring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#ffd24a calc(var(--cd,0)*1%),rgba(255,255,255,.12) 0);-webkit-mask:radial-gradient(circle,transparent 57%,#000 60%);mask:radial-gradient(circle,transparent 57%,#000 60%)}
.ba-rtimer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 19px ui-monospace,monospace;font-variant-numeric:tabular-nums}
.ba-rtip{font:600 13px ui-monospace,monospace;color:#9fd0ff;margin-top:14px}
#ba-shop{position:fixed;bottom:120px;left:50%;transform:translateX(-50%);width:min(92vw,560px);max-height:46vh;overflow-y:auto;background:rgba(10,14,24,.94);border:2px solid rgba(255,209,71,.4);border-radius:14px;padding:12px;pointer-events:auto;z-index:8}
.ba-shop-head{font:800 16px ui-monospace,monospace;color:#ffd24a;margin-bottom:8px}
.ba-shop-hint{font-size:11px;opacity:.6;font-weight:600}
/* minmax(0,…): grid items default to min-width:auto, so plain 1fr columns
   refuse to shrink below their content and the right column's price is clipped
   by the panel edge on a phone. */
.ba-shop-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px}
.ba-item{display:flex;flex-direction:row;align-items:center;text-align:left;gap:9px;background:rgba(30,36,52,.8);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 9px;color:#fff;cursor:pointer;font-family:ui-monospace,monospace}
.ba-item.afford{border-color:rgba(107,255,142,.6)}
.ba-item:disabled{opacity:.4;cursor:not-allowed}
.ba-si{width:36px;height:36px;border-radius:7px;flex:0 0 auto;border:1px solid rgba(255,255,255,.2);object-fit:cover}
.ba-icol{display:flex;flex-direction:column;gap:2px;min-width:0}
.ba-iname{font-weight:800;font-size:13px}
.ba-item.active-item .ba-iname::after{content:" ⚡";color:#6bffcc}
.ba-idesc{font-size:10px;opacity:.7}
.ba-icost{font-size:12px;color:#ffd24a;font-weight:700;margin-left:auto;flex:0 0 auto}
#ba-end{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(20,16,28,.4),rgba(8,8,14,.85));backdrop-filter:blur(5px);z-index:20}
.ba-end-card{text-align:center;pointer-events:auto}
.ba-end-title{font:900 italic clamp(40px,12vw,90px) system-ui,sans-serif;letter-spacing:-2px;text-shadow:0 6px 0 rgba(0,0,0,.5);animation:ba-endin .5s cubic-bezier(.2,1.4,.4,1)}
.ba-end-title.win{color:#6bff8e;text-shadow:0 0 60px rgba(107,255,142,.5),0 6px 0 rgba(0,0,0,.5)}
.ba-end-title.loss{color:#ff6a6a;text-shadow:0 0 60px rgba(255,106,106,.4),0 6px 0 rgba(0,0,0,.5)}
@keyframes ba-endin{from{transform:scale(.7);letter-spacing:8px;opacity:0}}
.ba-end-sub{font:600 18px ui-monospace,monospace;margin-top:8px;opacity:.9;display:flex;align-items:center;justify-content:center;gap:8px}
.ba-es{width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,255,255,.3)}
.ba-end-stats{font:700 15px ui-monospace,monospace;display:flex;gap:18px;justify-content:center;flex-wrap:wrap;max-width:calc(100vw - 32px);margin:14px auto 0;opacity:.9}
.ba-end-stats span{white-space:nowrap}
.ba-end-stats small{font:700 10px ui-monospace,monospace}
.ba-end-stats b{color:#ffd24a;font-size:22px;margin-right:3px}
.ba-end-best{font:800 13px ui-monospace,monospace;letter-spacing:2px;margin-top:10px;opacity:.7}
.ba-end-best.nb{color:#ffd24a;opacity:1;animation:ba-pop .4s}
.ba-end-btns{display:flex;gap:12px;justify-content:center;margin-top:26px}
.ba-end-btn{font:800 16px ui-monospace,monospace;letter-spacing:2px;color:#14111a;background:#ffd24a;border:none;border-radius:10px;padding:14px 26px;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.4)}
.ba-end-btn.alt{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.3)}
@keyframes ba-in{from{opacity:0;transform:translateX(12px)}}
@keyframes ba-pop{from{opacity:0;transform:scale(.7)}}
/* touch mode (any viewport): the touch grid (bottom-right) duplicates the
   ability tiles (icons + cooldown sweeps), so hide the desktop row and pin the
   remaining vitals/belt cluster bottom-LEFT, clear of the 3-column button grid. */
body.ba-touch-on #ba-left{left:calc(12px + env(safe-area-inset-left));bottom:calc(16px + env(safe-area-inset-bottom));max-width:170px}
body.ba-touch-on #ba-abilities{display:none}
body.ba-touch-on #ba-vitals{width:170px}
/* keep the hint and belt clear of the bottom-right button grid */
body.ba-touch-on #ba-hint{max-width:170px;font-size:11px}
body.ba-touch-on .ba-item-chip{width:28px;height:28px}
/* the shared @repo/embed pause+mute cluster owns the top-right corner on a
   coarse pointer, so the kill feed starts below it */
body.ba-touch-on #ba-feed{top:calc(76px + env(safe-area-inset-top))}
/* phone compaction — narrow (portrait) OR short (landscape) viewports */
@media (max-width:720px),(max-height:500px){
#ba-board{display:none}
/* the tapped-timer scoreboard drops below #ba-top instead of over it — the
   timer is also the toggle back off, so it has to stay readable */
#ba-board.force{display:flex;top:calc(92px + env(safe-area-inset-top))}
#ba-minimap{display:none}
.ba-abil{width:48px;height:48px}
.ba-abil.ult{width:52px;height:52px}
.ba-abil.util{width:38px;height:38px}
.ba-abil-gap{width:6px}
#ba-vitals{width:250px}
.ba-item-chip{width:32px;height:32px}
.ba-buff{width:22px;height:22px}
#ba-objective{gap:4px;flex-direction:column;font-size:9px;letter-spacing:0;margin-top:3px}
#ba-goal-banner{font-size:14px;padding:9px 14px}
#ba-hint{max-width:250px;font-size:12px}
#ba-intro{font-size:54px}
#ba-timer{font-size:30px}
.ba-end-sub{font-size:14px;margin-top:4px}
.ba-end-stats{gap:12px;margin-top:8px;font-size:13px}
.ba-end-btns{margin-top:14px}
.ba-end-btn{padding:11px 20px;font-size:14px}
.ba-rtitle{font-size:40px}
}
@media (max-height:500px) and (min-width:521px){
#ba-kit-btn{top:calc(12px + env(safe-area-inset-top));left:calc(16px + env(safe-area-inset-left));right:auto}
#ba-menu-btn{top:calc(12px + env(safe-area-inset-top));left:calc(112px + env(safe-area-inset-left));right:auto}
#ba-goal-banner{top:calc(98px + env(safe-area-inset-top))}
#ba-abilities{display:grid;grid-template-columns:repeat(3,52px);align-items:end}
#ba-abilities .ba-abil-gap{display:none}
}
@media (prefers-reduced-motion:reduce){
.ba-kill,.ba-toast,.ba-end-title,.ba-end-best.nb{animation:none}
}
/* portrait phones: two shop columns leave ~100px for a name + a description,
   so the grid collapses to one readable column and scrolls instead */
@media (max-width:520px){
#ba-goal-banner{top:max(calc(202px + env(safe-area-inset-top)),22%)}
.ba-shop-grid{grid-template-columns:minmax(0,1fr)}
#ba-left{bottom:calc(92px + env(safe-area-inset-bottom))}
#ba-abilities{left:50%;right:auto;transform:translateX(-50%);gap:6px}
body.ba-touch-on #ba-abilities{display:none}
}
`;

// keep ItemDef referenced for tooling
export type { ItemDef };
